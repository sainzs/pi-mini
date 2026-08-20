/**
 * The supervisor — J-Space's inference-time control plane for the two failure
 * sides of a summoned run.
 *
 * J-Space's "chain-of-thought diode" observation: a session locks into one of
 * two stable modes and cannot re-balance mid-flight. The harness cannot switch
 * the mode either — but it *sees every command*, so it can detect the mode's
 * characteristic stall and inject a bounded correction:
 *
 *  - **Short-thought side** (premature convergence): handled by the submit gate
 *    in `runner.ts`, not here — a fast judgment cannot end the run without
 *    `Verified` journal entries and an observed acceptance pass.
 *  - **Long-thought side** (analysis inertia): N consecutive read-only steps on
 *    a task licensed to write → nudge toward bounded candidates and one action.
 *    This is J-Space's "explicit Next, limited candidates".
 *  - **Seam refresh** (both sides): the same normalized command repeated → the
 *    evidence is already in context; force a journal write and a *different*
 *    action. J-Space's "tool-seam refresh and recovery".
 *  - **Stale ledger**: no journal write in K steps → nudge a fresh journal
 *    *write*. Settled-state decay is covered separately: the journal digest
 *    re-broadcasts itself on the `sh` tail every `digestEvery` steps (and in
 *    full after the first elision) — harness-enforced, never prompt-requested.
 *
 * Nudges ride the `sh` result — appended at the tail of the message the model
 * is about to read anyway, so they cost one cache-write increment and no extra
 * turn. Each is ≤ ~350 chars and fires at most once per episode per type; the
 * counters land in the audit row, which turns "how much steering does model X
 * need on task class Y" into a grep over audit.ndjson.
 */

export interface BandTuning {
	/** Steps without a journal write before a refresh nudge. */
	journalStaleAfter: number;
	/** Consecutive read-only steps on a write task before an inertia nudge. */
	inertiaAfter: number;
	/** Repeats of the same normalized command before a seam-refresh nudge. */
	repeatAfter: number;
	/** Submit rejections before the gate yields (and labels the envelope). */
	maxSubmitRejections: number;
	/**
	 * Steps between mechanical journal-digest re-broadcasts on the `sh` tail.
	 * Independent of the stale-journal *nudge*, which still asks for a fresh write.
	 */
	digestEvery: number;
}

/** Discrete behavior bands — J-Space's routing insight: bands, not knobs. */
export const BANDS: Record<"quick" | "standard" | "deep", BandTuning> = {
	quick: { journalStaleAfter: 5, inertiaAfter: 4, repeatAfter: 3, maxSubmitRejections: 2, digestEvery: 4 },
	standard: { journalStaleAfter: 8, inertiaAfter: 6, repeatAfter: 3, maxSubmitRejections: 2, digestEvery: 6 },
	deep: { journalStaleAfter: 8, inertiaAfter: 10, repeatAfter: 4, maxSubmitRejections: 3, digestEvery: 8 },
};

/** Commands whose execution plausibly changes the work tree. */
const WRITEISH_RX =
	/(^|[|;&]|&&|\|\|)\s*(sed\s+-i|apply_patch|patch\b|tee\b|mv\b|cp\b|rm\b|mkdir|touch|chmod|chown|ln\b|git\s+(apply|checkout|restore|merge|commit|add)|npm\s+(i|install)|pnpm\s+(i|install|add)|yarn\s+(add|install)|pip(3)?\s+install|brew\s+install|cargo\s+(build|install)|make\b)|(^|[^-])>>?[^&]/;

function normalize(cmd: string): string {
	return cmd.replace(/\s+/g, " ").trim();
}

export interface SupervisorSignals {
	/** Write-set lease was declared (non-empty) — the task is expected to write. */
	expectsWrite: boolean;
	tuning: BandTuning;
}

export type SteerKind = "repeat" | "inertia" | "journal";

export class Supervisor {
	private readonly signals: SupervisorSignals;
	private lastCommand = "";
	private consecutiveRepeats = 0;
	private stepsSinceWrite = 0;
	/** Per-kind step of last firing, so one nudge cannot spam every step. */
	private readonly lastFired = new Map<SteerKind, number>();
	readonly counts: Record<SteerKind, number> = { repeat: 0, inertia: 0, journal: 0 };

	constructor(signals: SupervisorSignals) {
		this.signals = signals;
	}

	get totalSteers(): number {
		return this.counts.repeat + this.counts.inertia + this.counts.journal;
	}

	/** Band-tuned cadence for the mechanical journal digest on the `sh` tail. */
	get digestEvery(): number {
		return this.signals.tuning.digestEvery;
	}

	/** Record one executed command. Returns whether it looked write-ish. */
	noteCommand(command: string): boolean {
		const norm = normalize(command);
		if (norm === this.lastCommand) this.consecutiveRepeats++;
		else {
			this.consecutiveRepeats = 0;
			this.lastCommand = norm;
		}
		const writeish = WRITEISH_RX.test(norm);
		if (writeish) this.stepsSinceWrite = 0;
		else this.stepsSinceWrite++;
		return writeish;
	}

	/**
	 * The nudge for this step, or undefined. Priority: seam refresh, then
	 * inertia, then stale journal — the earlier ones subsume the later.
	 */
	nudge(step: number, lastJournalStep: number): { kind: SteerKind; text: string } | undefined {
		const t = this.signals.tuning;
		if (this.consecutiveRepeats >= t.repeatAfter - 1 && this.canFire("repeat", step, 4)) {
			return this.fire("repeat", step, [
				"[supervisor] You have run the same command repeatedly; its evidence is already in context.",
				"Journal what it proved (verified), then take a DIFFERENT action — or submit if done.",
			].join(" "));
		}
		if (
			this.signals.expectsWrite &&
			this.stepsSinceWrite >= t.inertiaAfter &&
			step >= 4 &&
			this.canFire("inertia", step, t.inertiaAfter)
		) {
			return this.fire("inertia", step, [
				`[supervisor] ${this.stepsSinceWrite} consecutive read-only steps on a task licensed to write.`,
				"Analysis past this point rarely adds constraints: journal at most 3 candidate next actions,",
				"pick ONE, and execute it now.",
			].join(" "));
		}
		const staleBy = step - lastJournalStep;
		if (step >= 6 && staleBy >= t.journalStaleAfter && this.canFire("journal", step, t.journalStaleAfter)) {
			return this.fire("journal", step, [
				`[supervisor] No journal update in ${staleBy} steps. State drift compounds silently:`,
				"rewrite goal / core / verified / open / next from what you NOW know before acting further.",
			].join(" "));
		}
		return undefined;
	}

	/** Fire a kind at most once per `cooldown` steps. */
	private canFire(kind: SteerKind, step: number, cooldown: number): boolean {
		const last = this.lastFired.get(kind);
		return last === undefined || step - last >= cooldown;
	}

	private fire(kind: SteerKind, step: number, text: string): { kind: SteerKind; text: string } {
		this.lastFired.set(kind, step);
		this.counts[kind]++;
		return { kind, text };
	}
}
