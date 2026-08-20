/**
 * The run journal — J-Space's loop ledger (Goal / Core / Verified / Open / Next),
 * made machine-checkable.
 *
 * J-Space Cognition Suite V3.6 treats the ledger as the backbone of a summoned
 * run: reasoning state lives in an external, structured artifact instead of
 * decaying inside a growing transcript. Two failure modes it addresses, both
 * observed across 2026-08 delegation runs on this machine:
 *
 *  - **Long-range drift** (long-thought side): after many steps the model
 *    re-plans from stale assumptions, re-litigating settled constraints. The
 *    journal pins `Core` (binding constraints/decisions) so they are re-asserted
 *    on demand rather than re-deriving from a 30-step transcript.
 *  - **Premature conclusion** (short-thought side): a fast judgment delivered
 *    without bridge or evidence. The submit gate requires `Verified` entries —
 *    claims paired with the command output that proves them — before a run may
 *    end. That is J-Space's "bridge-before-conclusion" turned from discipline
 *    into a gate.
 *
 * Design notes:
 *  - Full-state writes, last-write-wins. Diffs would let a confused model
 *    corrupt the ledger incrementally; a full rewrite is self-healing.
 *  - Hard caps per field. The journal re-enters the transcript on refresh
 *    nudges, so its size is a permanent cache-read tax; caps are enforced by
 *    code, not by asking nicely.
 *  - The harness records update cadence (`lastJournalStep`) so the supervisor
 *    can detect a stale ledger and inject a refresh.
 *  - Settled constraints are re-broadcast *mechanically* on the `sh` tail
 *    (cadenced digest, and a one-shot full render after the first elision).
 *    Drift-resistance must not depend on the model cooperating with a nudge.
 *    Harness-enforced by code, never prompt-requested.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface JournalState {
	goal?: string;
	core: string[];
	verified: string[];
	open: string[];
	next?: string;
	/** Step of the most recent journal write; -1 when never written. */
	lastJournalStep: number;
	/** Total journal writes this run. */
	updates: number;
}

const CAP = {
	goal: 500,
	items: { core: 8, verified: 12, open: 8 },
	item: 200,
	next: 200,
};

function capItem(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > CAP.item ? `${oneLine.slice(0, CAP.item)}…` : oneLine;
}

function capList(items: string[] | undefined, max: number): string[] {
	if (!Array.isArray(items)) return [];
	return items.slice(0, max).map(capItem).filter((s) => s.length > 0);
}

export function createJournalState(): JournalState {
	return { core: [], verified: [], open: [], lastJournalStep: -1, updates: 0 };
}

/** Render the journal as the run-dir artifact the caller can read directly. */
export function renderJournal(state: JournalState): string {
	const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");
	return [
		`# Goal`,
		state.goal ?? "(unset)",
		``,
		`# Core — binding constraints & decisions`,
		list(state.core),
		``,
		`# Verified — claims with the command output that proves them`,
		list(state.verified),
		``,
		`# Open — unknowns & blockers`,
		list(state.open),
		``,
		`# Next — the single next action`,
		state.next ?? "(unset)",
	].join("\n");
}

/**
 * A bounded one-liner for re-injection when the ledger goes stale — J-Space's
 * "shared constraint broadcast": settled constraints are re-asserted rather
 * than left to decay in the transcript tail.
 */
export function journalDigest(state: JournalState): string {
	const lines = [`goal: ${state.goal ?? "(unset)"}`];
	if (state.core.length) lines.push(`core: ${state.core.join(" · ")}`);
	if (state.verified.length) lines.push(`verified: ${state.verified.length} item(s), latest: ${state.verified[state.verified.length - 1]}`);
	if (state.open.length) lines.push(`open: ${state.open.join(" · ")}`);
	if (state.next) lines.push(`next: ${state.next}`);
	return lines.join(" · ");
}

/** True when the journal holds any settled state worth re-broadcasting. */
export function journalIsPopulated(state: JournalState): boolean {
	return Boolean(state.goal) || state.core.length > 0 || state.verified.length > 0 || state.open.length > 0 || Boolean(state.next);
}

/** Cap on the full journal body re-broadcast after the first elision. */
export const JOURNAL_REBROADCAST_CAP = 1_500;

/** Cadenced digest line that rides the `sh` result tail. */
export function formatJournalDigestLine(state: JournalState): string {
	return `[journal] ${journalDigest(state)}`;
}

/** One-shot full-journal re-broadcast after context decay (first elision). */
export function formatJournalRebroadcast(state: JournalState): string {
	const body = renderJournal(state);
	const capped = body.length > JOURNAL_REBROADCAST_CAP ? body.slice(0, JOURNAL_REBROADCAST_CAP) : body;
	return `[journal — re-broadcast after elision]\n${capped}`;
}

export interface JournalSeamInput {
	state: JournalState;
	step: number;
	digestEvery: number;
	/** Supervisor fired a kind-"journal" nudge on this same result — digest is redundant. */
	journalNudge: boolean;
	/** This `sh` observation was elided (the `<elided_chars>` marker). */
	elidedThisStep: boolean;
}

/**
 * J-Space seam recovery for the journal.
 *
 * Two mechanical re-broadcasts, both riding the `sh` tail so they cost one
 * cache-write increment and no extra turn:
 *
 *  1. A one-line digest every `digestEvery` steps (band-tuned), skipped when
 *     the journal is empty or a stale-journal *nudge* already fired this step.
 *  2. After the first elision of the run, the *next* `sh` result gets the full
 *     rendered journal once, capped, so settled constraints survive the decay
 *     event rather than waiting for the model to rewrite them.
 *
 * The stale-journal nudge is unchanged: it still asks for a fresh write. The
 * digest covers decay of state that is already settled.
 */
export class JournalSeam {
	private firstElisionSeen = false;
	private rebroadcastDue = false;
	private rebroadcastSent = false;

	tail(input: JournalSeamInput): string | undefined {
		const rebroadcast = this.takeRebroadcast(input.state);
		if (input.elidedThisStep && !this.firstElisionSeen) {
			this.firstElisionSeen = true;
			this.rebroadcastDue = true;
		}
		if (rebroadcast) return rebroadcast;
		return this.digestLine(input);
	}

	private takeRebroadcast(state: JournalState): string | undefined {
		if (!this.rebroadcastDue || this.rebroadcastSent) return undefined;
		this.rebroadcastDue = false;
		this.rebroadcastSent = true;
		if (!journalIsPopulated(state)) return undefined;
		return formatJournalRebroadcast(state);
	}

	private digestLine(input: JournalSeamInput): string | undefined {
		if (input.journalNudge) return undefined;
		if (!journalIsPopulated(input.state)) return undefined;
		if (input.digestEvery <= 0) return undefined;
		if (input.step <= 0 || input.step % input.digestEvery !== 0) return undefined;
		return formatJournalDigestLine(input.state);
	}
}

export interface JournalToolInput {
	state: JournalState;
	/** Run dir; journal.md is rewritten on every update. */
	dir: string;
	/** Current step, for staleness tracking. Reads the budget's step counter. */
	currentStep: () => number;
}

/**
 * `journal` — the run's externalized state. One write replaces the whole
 * ledger; the tool result is a compact acknowledgment, not an echo, so the
 * transcript stays lean.
 */
export function createJournalTool(input: JournalToolInput): ToolDefinition {
	const { state, dir, currentStep } = input;
	return defineTool({
		name: "journal",
		label: "journal",
		description:
			"Write the run journal: externalized task state in five sections — goal (what done means), " +
			"core (binding constraints/decisions you must not lose), verified (claims + the command output " +
			"that proves them), open (unknowns/blockers), next (the ONE concrete action you will take). " +
			"Each write replaces the whole journal. Update it whenever verified grows, a constraint is " +
			"learned, or next changes. A run may not submit without at least one verified entry.",
		promptSnippet: "Externalize task state: goal / core / verified / open / next",
		parameters: Type.Object({
			goal: Type.Optional(Type.String({ description: "What 'done' means for this run. Restate it when your understanding changes." })),
			core: Type.Optional(Type.Array(Type.String(), { description: `Binding constraints and decisions, ≤${CAP.items.core}. The things a later step must not forget.` })),
			verified: Type.Optional(Type.Array(Type.String(), { description: `Claims paired with the command output that proves them, ≤${CAP.items.verified}. Required before submit.` })),
			open: Type.Optional(Type.Array(Type.String(), { description: `Unknowns and blockers, ≤${CAP.items.open}.` })),
			next: Type.Optional(Type.String({ description: "The single next concrete action. Not a plan — one action." })),
		}),
		async execute(_toolCallId, params) {
			if (typeof params.goal === "string") {
				const g = params.goal.trim();
				state.goal = g.length > CAP.goal ? `${g.slice(0, CAP.goal)}…` : g;
			}
			if (params.core !== undefined) state.core = capList(params.core, CAP.items.core);
			if (params.verified !== undefined) state.verified = capList(params.verified, CAP.items.verified);
			if (params.open !== undefined) state.open = capList(params.open, CAP.items.open);
			if (typeof params.next === "string") state.next = capItem(params.next);

			state.updates++;
			state.lastJournalStep = currentStep();

			try {
				writeFileSync(join(dir, "journal.md"), renderJournal(state), "utf-8");
			} catch {
				// Persistence failure must never fail the step; state lives in memory too.
			}

			return {
				content: [
					{
						type: "text" as const,
						text:
							`journal recorded (update ${state.updates}, step ${state.lastJournalStep}). ` +
							`verified: ${state.verified.length} · open: ${state.open.length} · next: ${state.next ?? "(unset)"}`,
					},
				],
				details: undefined,
			};
		},
	}) as unknown as ToolDefinition;
}
