/**
 * Hard budgets — the feature pi genuinely lacks.
 *
 * pi has no `--max-turns` and no `--max-cost` (verified against `pi --help` and
 * docs/settings.md on 0.83.0). mini-swe-agent's entire "step limits cap the
 * bill" value proposition is this file and nothing else.
 *
 * Two properties matter, both copied from mini-swe-agent's `default.py`:
 *
 *  1. The check runs **before** the model call, not after. Post-hoc summing of
 *     usage lets a single request overrun by an unbounded amount (one 900k-token
 *     prompt is one "step"). `query()` in mini-swe checks limits before
 *     `self.model.query`; we check in `before_provider_request`, which fires
 *     after the payload is serialized and before the HTTP call.
 *  2. Exhaustion is a *reported exit status*, not an exception that loses work.
 */

/** Why a run stopped. Mirrors mini-swe-agent's `exit_status`. */
export type ExitReason =
	| "submitted"
	| "step_limit"
	| "cost_limit"
	| "wall_limit"
	| "tree_budget"
	| "aborted"
	/** The model binding itself is dead (auth/config failure on the first call). */
	| "binding_error"
	/** The provider throttled the run away (429/5xx streak); burned steps were refunded. */
	| "throttled"
	| "error";

export interface BudgetLimits {
	/** Max model calls. mini-swe-agent's `step_limit`; its default is 40. */
	steps: number;
	/** Max spend in USD for this run. mini-swe-agent's `cost_limit`; default 3.0. */
	usd: number;
	/** Max wall-clock ms. mini-swe-agent's `wall_time_limit_seconds`. */
	wallMs: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
	steps: 40,
	usd: 3.0,
	wallMs: 20 * 60 * 1000,
};

/**
 * A budget shared by a whole tree of summoned runs.
 *
 * Deliberately in-process and lock-free: every run is a nested
 * `AgentSession` on one event loop, so a module-scoped object is race-free.
 * A file-based ledger would only be needed if we spawned children — which is
 * one more reason not to (see PLAN.md D2).
 */
export class TreeBudget {
	readonly ceilingUsd: number;
	spentUsd = 0;

	constructor(ceilingUsd: number) {
		this.ceilingUsd = ceilingUsd;
	}

	get remainingUsd(): number {
		return Math.max(0, this.ceilingUsd - this.spentUsd);
	}

	get exhausted(): boolean {
		return this.spentUsd >= this.ceilingUsd;
	}
}

export interface BudgetSnapshot {
	steps: number;
	stepLimit: number;
	usd: number;
	usdLimit: number;
	elapsedMs: number;
	wallMs: number;
}

/** Per-run budget. Charges a shared `TreeBudget` so a whole fan-out is capped. */
export class Budget {
	readonly limits: BudgetLimits;
	readonly startedAt = Date.now();
	private readonly tree: TreeBudget;

	steps = 0;
	usd = 0;
	/** Set once a limit trips, so the runner can report a precise exit status. */
	tripped: ExitReason | undefined;

	constructor(limits: BudgetLimits, tree: TreeBudget) {
		this.limits = limits;
		this.tree = tree;
	}

	get elapsedMs(): number {
		return Date.now() - this.startedAt;
	}

	get stepsRemaining(): number {
		return Math.max(0, this.limits.steps - this.steps);
	}

	/**
	 * Pre-spend gate. Returns the reason to stop, or undefined to proceed.
	 *
	 * Called from `before_provider_request`, i.e. with the payload built but no
	 * HTTP call made yet — the only pre-spend checkpoint pi exposes.
	 */
	checkBeforeCall(): ExitReason | undefined {
		if (this.steps >= this.limits.steps) return this.trip("step_limit");
		if (this.usd >= this.limits.usd) return this.trip("cost_limit");
		if (this.elapsedMs >= this.limits.wallMs) return this.trip("wall_limit");
		if (this.tree.exhausted) return this.trip("tree_budget");
		return undefined;
	}

	private trip(reason: ExitReason): ExitReason {
		this.tripped ??= reason;
		return reason;
	}

	/** Count a model call that is about to be made. */
	countStep(): void {
		this.steps++;
	}

	/**
	 * Hand back a pre-charged step that did no work.
	 *
	 * Steps are charged in `before_provider_request`, ahead of the HTTP call,
	 * so a throttled request would otherwise consume budget it never spent.
	 * Observed 2026-08-20 on azure-foundry/DeepSeek-V4-Flash-0731 (eastus2):
	 * four consecutive 429s burned steps 4–7 of a run that did nothing — and on
	 * a zero-priced deployment steps are the only budget there is. Floored at
	 * 0; USD and the tree ceiling are untouched, because a rejected request
	 * cost no money — only a dishonestly counted step.
	 */
	refundStep(): void {
		this.steps = Math.max(0, this.steps - 1);
	}

	/** Charge observed spend to this run and to the shared tree ceiling. */
	charge(usd: number): void {
		if (!Number.isFinite(usd) || usd <= 0) return;
		this.usd += usd;
		this.tree.spentUsd += usd;
	}

	snapshot(): BudgetSnapshot {
		return {
			steps: this.steps,
			stepLimit: this.limits.steps,
			usd: this.usd,
			usdLimit: this.limits.usd,
			elapsedMs: this.elapsedMs,
			wallMs: this.limits.wallMs,
		};
	}

	/**
	 * A one-line nudge appended to tool output when the run is nearly done, so
	 * the model submits its best result instead of being cut off mid-thought.
	 * mini-swe-agent does the same thing by forcing a final submission turn.
	 */
	warningLine(): string | undefined {
		const left = this.stepsRemaining;
		if (left <= 2) {
			return `[budget] ${left} step${left === 1 ? "" : "s"} left — call submit now with your best result.`;
		}
		const usdLeft = this.limits.usd - this.usd;
		if (usdLeft <= this.limits.usd * 0.1) {
			return `[budget] ~$${usdLeft.toFixed(2)} left — call submit now with your best result.`;
		}
		const msLeft = this.limits.wallMs - this.elapsedMs;
		if (msLeft <= 60_000) {
			return `[budget] ${Math.max(0, Math.round(msLeft / 1000))}s left — call submit now with your best result.`;
		}
		return undefined;
	}
}
