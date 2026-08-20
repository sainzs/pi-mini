/**
 * Drives one summoned run.
 *
 * The run is a nested in-process `AgentSession`, not a spawned `pi` child.
 * Measured on this machine at pi 0.83.0: `createAgentSession()` costs 50 ms cold
 * and 16 ms warm in an already-running process, against 560 ms to spawn
 * `node dist/cli.js` — and the 560 ms figure is a floor, taken from the error
 * path before any model or extension setup. `docs/rpc.md:6` recommends the same
 * thing: use `AgentSession` directly rather than a subprocess.
 *
 * In-process also gives us real cancellation (`session.abort()` rather than
 * signalling a process group), exact budget accounting, and no session files to
 * orphan.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	type ModelRuntime,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Budget, type BudgetLimits, type ExitReason, type TreeBudget } from "./budget.ts";
import { CheckpointRecorder } from "./checkpoints.ts";
import type { RunResult } from "./envelope.ts";
import { createSubmitGate } from "./gate.ts";
import { createJournalState, createJournalTool, renderJournal } from "./journal.ts";
import { appendRecord, createLedger } from "./ledger.ts";
import { captureLeaseBaseline, leaseViolations, observeChanges } from "./lease.ts";
import { MiniResourceLoader } from "./loader.ts";
import { buildSystemPrompt, buildTaskMessage } from "./prompt.ts";
import { BANDS, Supervisor } from "./supervisor.ts";
import { runAcceptance } from "./verify.ts";
import {
	createLocateTool,
	createShTool,
	createSubmitTool,
	scoutCanServe,
	SH_COMMAND_PREFIX,
	type SubmitDetails,
} from "./tools.ts";

/** pi's documented thinking levels (`pi --help`); pi-agent-core is not a direct dep. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Discrete behavior bands — J-Space's routing insight, and its caution: treat
 * bands as attractors, not a continuous depth knob. `standard` inherits the
 * caller's thinking level rather than pinning an unstable middle.
 */
export type Band = "quick" | "standard" | "deep";
const BAND_THINKING: Record<Band, ThinkingLevel | undefined> = {
	quick: "low",
	standard: undefined,
	deep: "high",
};

export interface RunOptions {
	task: string;
	contextPack?: string;
	cwd: string;
	limits: BudgetLimits;
	tree: TreeBudget;
	baseDir: string;
	runId: string;
	/** Inherited from the caller so a summoned run bills and behaves predictably. */
	model?: Model<Api>;
	modelRuntime?: ModelRuntime;
	/** Read-only runs get no write/edit path; `sh` is still granted, so this is advisory. */
	retrieval: "auto" | "off";
	/**
	 * Acceptance predicate: a shell command the HARNESS runs after the child
	 * finishes; exit 0 defines "done". Shown to the child as its contract.
	 */
	accept?: string;
	/** Write-set lease: glob/path patterns the child may change. Observed, not sandboxed. */
	lease?: string[];
	/** Behavior band: entry routing + supervisor cadence. Default `standard`. */
	band?: Band;
	signal?: AbortSignal;
	onProgress?: (text: string) => void;
}

export async function runMiniAgent(options: RunOptions): Promise<RunResult> {
	const ledger = createLedger(options.baseDir, options.runId);
	const budget = new Budget(options.limits, options.tree);

	// Ground truth is captured by the harness before the child exists, so the
	// envelope's file list can come from observation rather than testimony.
	const leaseBaseline = await captureLeaseBaseline(options.cwd);
	appendRecord(ledger.transcript, {
		type: "lease_baseline",
		git: leaseBaseline.git,
		dirtyCount: leaseBaseline.entries.size,
	});

	const hasLocate = options.retrieval === "auto" && (await scoutCanServe(options.cwd));

	// The J-Space control plane for this run: externalized ledger (journal),
	// stall/inertia detection (supervisor), and recovery points (checkpoints).
	const band: Band = options.band ?? "standard";
	const tuning = BANDS[band];
	const journal = createJournalState();
	const supervisor = new Supervisor({
		expectsWrite: (options.lease?.length ?? 0) > 0,
		tuning,
	});
	const checkpoints = new CheckpointRecorder(options.cwd, ledger.dir, leaseBaseline.root);

	let submitted: SubmitDetails | undefined;
	let sessionRef: AgentSession | undefined;
	let stopReason: ExitReason | undefined;

	/**
	 * The submit gate — J-Space's bridge-before-conclusion and verifier coverage,
	 * moved from discipline into the harness. Acceptance is executed HERE, not
	 * inferred from the child's `sh` command text (see `gate.ts`).
	 */
	const { gate: submitGate, state: gateState } = createSubmitGate({
		hasVerified: () => journal.verified.length > 0,
		accept: options.accept,
		cwd: options.cwd,
		maxRejections: tuning.maxSubmitRejections,
	});

	/**
	 * The pre-spend gate.
	 *
	 * `before_provider_request` fires after the payload is serialized and before
	 * the HTTP call — the only checkpoint pi offers that is genuinely ahead of
	 * spend. Checking after a turn instead would let one oversized request blow
	 * the budget by an unbounded amount, since a 900k-token prompt is still just
	 * "one step".
	 *
	 * We both abort the session and throw: the abort stops the loop, and the
	 * throw stops *this* request even if the runner swallows handler errors.
	 * Worst case the overrun is bounded to a single request.
	 */
	const gate = {
		event: "before_provider_request",
		handler: () => {
			const stop = budget.checkBeforeCall();
			if (stop) {
				stopReason ??= stop;
				appendRecord(ledger.transcript, { type: "budget_stop", reason: stop, ...budget.snapshot() });
				void sessionRef?.abort();
				throw new Error(`pi-mini budget stop: ${stop}`);
			}
			budget.countStep();
			options.onProgress?.(`step ${budget.steps}/${budget.limits.steps} · $${budget.usd.toFixed(3)}`);
			return undefined;
		},
	};

	const tools: ToolDefinition[] = [
		createShTool({
			cwd: options.cwd,
			budget,
			ledger,
			commandPrefix: SH_COMMAND_PREFIX,
			supervisor,
			checkpoints,
			lastJournalStep: () => journal.lastJournalStep,
		}),
		createSubmitTool(
			(details) => {
				submitted = details;
			},
			submitGate,
			() => {
				appendRecord(ledger.transcript, { type: "submit_rejected", count: gateState.rejections });
			},
		),
		createJournalTool({ state: journal, dir: ledger.dir, currentStep: () => budget.steps }),
	];
	if (hasLocate) tools.push(createLocateTool(options.cwd));

	const systemPrompt = buildSystemPrompt({
		limits: options.limits,
		hasLocate,
		cwd: options.cwd,
		lease: options.lease,
		band,
	});

	const { session } = await createAgentSession({
		cwd: options.cwd,
		model: options.model,
		modelRuntime: options.modelRuntime,
		// Band routing happens at entry (J-Space): quick/deep pin a thinking level;
		// standard inherits the caller's.
		...(BAND_THINKING[band] ? { thinkingLevel: BAND_THINKING[band] as never } : {}),
		sessionManager: SessionManager.inMemory(),
		resourceLoader: new MiniResourceLoader({ systemPrompt, handlers: [gate] }),
		customTools: tools,
		// Closed toolset: only what this runtime registered. No read/edit/write/
		// grep/find/ls, so there is exactly one way to act.
		noTools: "all",
		tools: tools.map((tool) => tool.name),
	});
	sessionRef = session;

	// Charge spend as it is observed, and keep a full local transcript. Provider
	// failures (429 throttling, 5xx) end as assistant messages with an
	// errorMessage rather than a thrown prompt — capture the last one, or a run
	// killed by throttling reports only its lease warning as the "error".
	// Observed 2026-08-20: four consecutive 429s on DeepSeek-V4-Flash-0731
	// burned steps 4–7 and the envelope never mentioned the rate limit.
	let lastProviderError: string | undefined;
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "message_end") return;
		const message = event.message as {
			role?: string;
			stopReason?: string;
			errorMessage?: string;
			usage?: { cost?: { total?: number } };
		};
		if (message.role === "assistant" && message.usage?.cost?.total) {
			budget.charge(message.usage.cost.total);
		}
		if (message.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
			lastProviderError = message.errorMessage.slice(0, 300);
		}
		appendRecord(ledger.transcript, { type: "message", message: event.message });
	});

	const onAbort = () => {
		stopReason ??= "aborted";
		void session.abort();
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	let error: string | undefined;
	try {
		await session.prompt(buildTaskMessage(options.task, options.contextPack, options.accept));
	} catch (cause) {
		// A budget stop surfaces here as the gate's throw; that is expected control
		// flow, not a failure to report.
		if (!stopReason && !budget.tripped) {
			error = cause instanceof Error ? cause.message : String(cause);
			stopReason = "error";
		}
	} finally {
		options.signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		try {
			session.dispose();
		} catch {
			// disposal must never mask the result
		}
	}

	let exitReason: ExitReason = submitted
		? "submitted"
		: (budget.tripped ?? stopReason ?? "error");
	if (exitReason === "error" && !error && lastProviderError) {
		error = lastProviderError;
	}

	// A dead model binding fails on the FIRST provider call with an auth/config
	// error. Without this classification it reads as a generic "error" — or
	// worse, in harnesses without a submission contract, as silent success.
	// Observed 2026-08-07: a whole dispatch wave "completed" against a disabled
	// provider having done zero work.
	if (exitReason === "error" && error && budget.steps <= 1 && BINDING_ERROR_RX.test(error)) {
		exitReason = "binding_error";
	}

	// Observation before testimony: what actually changed on disk.
	const changes = await observeChanges(options.cwd, leaseBaseline);
	const claimed = submitted?.filesChanged ?? [];
	const observed = changes.observed;
	const violations =
		observed !== undefined ? leaseViolations(observed, options.lease ?? []) : [];

	// The caller's definition of done, run by the harness, after the child is gone.
	const verification = options.accept
		? await runAcceptance(options.accept, options.cwd)
		: undefined;
	if (verification) {
		appendRecord(ledger.transcript, { type: "verification", ...verification });
	}

	const result: RunResult = {
		exitReason,
		summary: submitted?.summary ?? fallbackSummary(session, exitReason),
		filesChanged: observed ?? claimed,
		filesChangedSource: observed !== undefined ? "observed" : claimed.length > 0 ? "claimed" : "none",
		claimedFilesChanged: claimed,
		...(verification ? { verification } : {}),
		...(violations.length > 0 ? { leaseViolations: violations } : {}),
		budget: budget.snapshot(),
		ledgerDir: ledger.dir,
		steps: budget.steps,
		costUsd: budget.usd,
		band,
		...(options.model?.id ? { model: options.model.id } : {}),
		control: {
			journalUpdates: journal.updates,
			verifiedEntries: journal.verified.length,
			openItems: journal.open.length,
			steers: { ...supervisor.counts },
			checkpoints: checkpoints.count,
			...(checkpoints.count > 0 ? { checkpointsDir: checkpoints.dir } : {}),
			submitRejections: gateState.rejections,
			...(gateState.gateOverridden ? { gateOverridden: true } : {}),
			...(options.accept ? { acceptPassObserved: gateState.acceptObservedPass } : {}),
		},
		...(error ? { error } : {}),
		...(changes.unverifiable ? { error: [error, `[lease] ${changes.unverifiable}`].filter(Boolean).join("; ") } : {}),
	};

	// The final journal state is an artifact the caller can read without the
	// transcript: J-Space's ledger is the run's durable memory.
	appendRecord(ledger.transcript, { type: "journal_final", journal: renderJournal(journal) });

	appendRecord(ledger.transcript, { type: "result", result });
	return result;
}

/** Signatures of a dead/misconfigured model binding on the first call. */
const BINDING_ERROR_RX =
	/\b401\b|\b403\b|unauthorized|forbidden|api key|apikey|model is disabled|no provider|model not found|missing.*base.?url|invalid.*credential/i;

/**
 * When a run ends without submitting, salvage the last assistant text.
 *
 * This is explicitly a fallback, never the primary path — scraping the last
 * message is exactly the unreliable behaviour the `submit` contract exists to
 * replace, and the envelope labels such results as partial.
 */
function fallbackSummary(session: AgentSession, reason: ExitReason): string {
	const messages = session.messages as Array<{
		role?: string;
		content?: unknown;
	}>;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		const text = extractText(message.content);
		if (text) return `(no submit call; stopped on "${reason}") Last assistant output:\n\n${text}`;
	}
	return `(no result reported; stopped on "${reason}")`;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => {
			const candidate = block as { type?: string; text?: unknown };
			return candidate?.type === "text" && typeof candidate.text === "string";
		})
		.map((block) => block.text)
		.join("\n")
		.trim();
}
