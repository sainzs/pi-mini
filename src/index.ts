/**
 * pi-mini — a bounded task runtime any agent can summon.
 *
 * Registers one tool, `mini`. Give it a brief and a budget; it runs a
 * mini-swe-agent-style loop (one shell action per step, explicit submission) in a
 * nested in-process session and returns a capped, fixed-schema result.
 *
 * The safety properties that make "summonable from anywhere" acceptable:
 *
 *  - **Depth cap.** Summoned runs receive a closed resource set with no
 *    extensions (`MiniResourceLoader`), so they cannot re-register this tool. The
 *    depth counter here is the second line of defence, not the first.
 *  - **Concurrency cap.** Parallel siblings each pay a full cache write on the
 *    shared prefix instead of one write plus reads, and pi's synchronous auth
 *    lock path busy-waits the event loop under contention. Low is correct.
 *  - **Hard budgets.** Steps, dollars and wall-clock, all checked pre-spend.
 *    Every other failure mode — a runaway loop, a hung child, a poisoned
 *    context — is bounded by these even if its specific mitigation is wrong.
 *  - **Capped envelope.** A child's output can never grow the caller's context
 *    without limit, and is framed as data rather than instructions.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_LIMITS, TreeBudget } from "./budget.ts";
import { formatEnvelope, isFailure } from "./envelope.ts";
import { auditSummon } from "./ledger.ts";
import { ProviderQueue } from "./queue.ts";
import { runMiniAgent, type Band } from "./runner.ts";

const DEPTH_ENV = "PI_MINI_DEPTH";
const MAX_DEPTH = Number(process.env.PI_MINI_MAX_DEPTH ?? 1);
const MAX_CONCURRENCY = Number(process.env.PI_MINI_CONCURRENCY ?? 2);
/** Ceiling shared by every run summoned from this process. */
const TREE_CEILING_USD = Number(process.env.PI_MINI_TREE_USD ?? 25);

const BASE_DIR = join(homedir(), ".pi", "agent", "mini");

/**
 * The default summoned-run model. DeepSeek-V4-Flash-0731 is deliberate: it is
 * the exact model the J-Space control plane was benchmarked on (NL2Repo
 * 54.2→70.2, DeepSWE 54.4→67.4 with the ledger/gate/supervisor stack), and it
 * is the cheapest strong deployment on the Azure Foundry resource. Override
 * per run with the `model` param / `--model` flag, or globally with
 * PI_MINI_MODEL. Unresolvable or unauthenticated specs fall back to
 * inheriting the caller's model, never to a silent failure.
 */
const DEFAULT_MODEL_SPEC = "azure-foundry/DeepSeek-V4-Flash-0731";
const MODEL_ENV = "PI_MINI_MODEL";

type ModelShape = { id?: string; provider?: string };

export interface ResolvedSummonModel<M extends ModelShape = ModelShape> {
	model: M | undefined;
	id: string;
	/** Where the choice came from: param, env, built-in default, or inheritance. */
	source: "param" | "env" | "default" | "inherited" | "inherited-fallback";
}

/**
 * Resolve a model spec against the registry. `provider/id` is exact; a bare id
 * matches case-insensitively, then by unique substring (azure-foundry wins
 * ties, since that is where the budget-friendly deployments live).
 */
export function resolveSummonModel<M extends ModelShape>(
	spec: string | undefined,
	registry:
		| {
				find(provider: string, modelId: string): M | undefined;
				getAvailable(): M[];
				hasConfiguredAuth(model: M): boolean;
			}
		| undefined,
	inherited: M | undefined,
): ResolvedSummonModel<M> {
	const inherit: ResolvedSummonModel<M> = {
		model: inherited,
		id: inherited?.id ?? "inherited-unknown",
		source: "inherited",
	};

	const attempt = (s: string, source: ResolvedSummonModel<M>["source"]): ResolvedSummonModel<M> | undefined => {
		if (!registry) return undefined;
		const trimmed = s.trim();
		if (!trimmed) return undefined;
		let found: M | undefined;
		if (trimmed.includes("/")) {
			const [provider, ...rest] = trimmed.split("/");
			found = registry.find(provider, rest.join("/"));
		} else {
			const available = registry.getAvailable();
			const exact = available.filter((m) => m.id?.toLowerCase() === trimmed.toLowerCase());
			const pool = exact.length
				? exact
				: available.filter((m) => m.id?.toLowerCase().includes(trimmed.toLowerCase()));
			found = pool.find((m) => m.provider === "azure-foundry") ?? pool[0];
		}
		if (!found || !registry.hasConfiguredAuth(found)) return undefined;
		return { model: found, id: found.id ?? trimmed, source };
	};

	if (spec) {
		const hit = attempt(spec, "param");
		return hit ?? { ...inherit, source: "inherited-fallback" };
	}
	const env = process.env[MODEL_ENV];
	if (env) {
		const hit = attempt(env, "env");
		return hit ?? { ...inherit, source: "inherited-fallback" };
	}
	return attempt(DEFAULT_MODEL_SPEC, "default") ?? { ...inherit, source: "inherited-fallback" };
}

const currentDepth = Number(process.env[DEPTH_ENV] ?? 0);
const treeBudget = new TreeBudget(TREE_CEILING_USD);

/** Total run cap; the provider queue below adds per-key limits and pacing. */
class Semaphore {
	private active = 0;
	private readonly waiting: Array<() => void> = [];

	private readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	async acquire(): Promise<() => void> {
		if (this.active >= this.limit) {
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		}
		this.active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.waiting.shift()?.();
		};
	}
}

const semaphore = new Semaphore(Math.max(1, MAX_CONCURRENCY));
const providerQueue = new ProviderQueue();

function summonQueueKey<M extends ModelShape>(resolved: ResolvedSummonModel<M>): string {
	return `${resolved.model?.provider ?? "unknown"}/${resolved.model?.id ?? resolved.id}`;
}

/** Live runs, so a parent shutdown cannot leave orphans behind. */
const live = new Set<AbortController>();

export default function (pi: ExtensionAPI) {
	// A summoned run has no extensions at all, so reaching this line inside one
	// means something loaded us explicitly. Refuse rather than recurse.
	if (currentDepth >= MAX_DEPTH) {
		return;
	}

	pi.on("session_shutdown", () => {
		for (const controller of live) controller.abort();
		live.clear();
	});

	pi.registerTool({
		name: "mini",
		label: "mini agent",
		description:
			"Summon a bounded sub-run to carry out one self-contained task, then report back. " +
			"The run works in a real shell with a hard step, dollar and time budget, and returns a " +
			"short structured result rather than its transcript. " +
			"Best for well-scoped work you can describe precisely: apply and verify a change, " +
			"reproduce a failure, audit a specific claim across files. " +
			"Give it a brief that already contains the paths and line numbers you know — that is far " +
			"cheaper than letting it rediscover them. It cannot ask you questions, so state the goal, " +
			"the boundary, and what 'done' means.",
		promptSnippet: "Summon a budgeted sub-run for a self-contained task",
		parameters: Type.Object({
			task: Type.String({
				description:
					"The brief. State the goal, the files or boundary it should stay within, and the " +
					"definition of done. Include known file:line locations.",
			}),
			contextPack: Type.Optional(
				Type.String({
					description:
						"Locations and facts you have already established, one per line (e.g. " +
						"`src/auth.ts:42-88 token refresh`). Supplying this is the cheapest possible " +
						"retrieval: the run starts from it instead of searching.",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the current one." })),
			steps: Type.Optional(
				Type.Number({ description: `Max model steps. Default ${DEFAULT_LIMITS.steps}.`, minimum: 1 }),
			),
			usd: Type.Optional(
				Type.Number({ description: `Max spend in USD. Default ${DEFAULT_LIMITS.usd}.`, minimum: 0.01 }),
			),
			minutes: Type.Optional(
				Type.Number({
					description: `Max wall-clock minutes. Default ${Math.round(DEFAULT_LIMITS.wallMs / 60000)}.`,
					minimum: 1,
				}),
			),
			retrieval: Type.Optional(
				Type.Union([Type.Literal("auto"), Type.Literal("off")], {
					description:
						"`auto` (default) gives the run a semantic `locate` tool when this repo is indexed. " +
						"`off` restricts it to the shell.",
				}),
			),
			accept: Type.Optional(
				Type.String({
					description:
						"Acceptance predicate: a shell command run BY THE CALLER'S HARNESS after the run " +
						"ends; exit 0 defines done (e.g. `npm test -- retry` or `test -f out/report.md`). " +
						"The verdict is attached to the result — declare one whenever done is checkable.",
				}),
			),
			lease: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Write-set lease: path or glob patterns the run may create/modify (e.g. " +
						"`src/http/**`). File changes are observed via git after the run; a write outside " +
						"the lease fails the result. Omit only for read-only work.",
				}),
			),
			band: Type.Optional(
				Type.Union([Type.Literal("quick"), Type.Literal("standard"), Type.Literal("deep")], {
					description:
						"Behavior band, routed at entry. `quick`: short-horizon tasks — low thinking, tight " +
						"steering cadence. `deep`: long-horizon — high thinking, more steps, patient inertia " +
						"window. `standard` (default): inherits the caller's thinking level. Bands are " +
						"discrete on purpose; there is no useful middle knob.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						`Model for the run: \`provider/id\` or a bare id (e.g. \`${DEFAULT_MODEL_SPEC}\` — the ` +
						"default, cheap and strong — or \`azure-foundry-claude/claude-opus-5\` for genuinely " +
						"hard reasoning). Omit to use the default; an unresolvable or unauthenticated choice " +
						"falls back to inheriting your model, flagged in the audit row.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const runId = randomUUID().slice(0, 8);
			const cwd = params.cwd ?? ctx.cwd ?? process.cwd();
			const limits = {
				steps: params.steps ?? DEFAULT_LIMITS.steps,
				usd: params.usd ?? DEFAULT_LIMITS.usd,
				wallMs: (params.minutes ?? DEFAULT_LIMITS.wallMs / 60000) * 60_000,
			};

			if (treeBudget.exhausted) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Refused: the $${TREE_CEILING_USD.toFixed(2)} ceiling for runs summoned from this ` +
								`session is spent ($${treeBudget.spentUsd.toFixed(2)}). Do the work directly, or raise ` +
								"PI_MINI_TREE_USD.",
						},
					],
					details: undefined,
					isError: true,
				};
			}

			const controller = new AbortController();
			live.add(controller);
			signal?.addEventListener("abort", () => controller.abort(), { once: true });

			const previousDepth = process.env[DEPTH_ENV];
			const globalRelease = await semaphore.acquire();
			let queueRelease: (() => void) | undefined;
			let queueWaitMs = 0;
			let startedAt = Date.now();

			try {
				const resolved = resolveSummonModel(params.model, ctx.modelRegistry, ctx.model);
				const queueStartedAt = Date.now();
				queueRelease = await providerQueue.acquire(summonQueueKey(resolved));
				queueWaitMs = Date.now() - queueStartedAt;
				startedAt = Date.now();
				process.env[DEPTH_ENV] = String(currentDepth + 1);
				onUpdate?.({ content: [{ type: "text", text: `mini ${runId}: starting` }], details: undefined });

				const result = await runMiniAgent({
					task: params.task,
					contextPack: params.contextPack,
					cwd,
					limits,
					tree: treeBudget,
					baseDir: BASE_DIR,
					runId,
					model: resolved.model,
					retrieval: params.retrieval ?? "auto",
					accept: params.accept,
					lease: params.lease,
					band: params.band,
					signal: controller.signal,
					onProgress: (text) =>
						onUpdate?.({
							content: [{ type: "text", text: `mini ${runId}: ${text}` }],
							details: undefined,
						}),
				});

				// One routing-ledger row per summon: model, verified outcome, lease
				// verdict, cost. This is what turns delegation from lore into data —
				// which model passes which task class at what price is answerable by
				// grepping audit.ndjson instead of remembering.
				const resolvedModel = resolved.model;
				auditSummon(BASE_DIR, {
					runId,
					depth: currentDepth,
					cwd,
					task: params.task.slice(0, 400),
					model: resolvedModel?.id ?? "inherited-unknown",
					modelSource: resolved.source,
					provider: resolvedModel?.provider,
					band: result.band,
					exitReason: result.exitReason,
					verified: result.verification ? result.verification.ok : "no-predicate",
					leaseViolations: result.leaseViolations?.length ?? 0,
					filesChanged: result.filesChanged.length,
					filesChangedSource: result.filesChangedSource,
					steps: result.steps,
					costUsd: Number(result.costUsd.toFixed(4)),
					elapsedMs: Date.now() - startedAt,
					queueWaitMs,
					treeSpentUsd: Number(treeBudget.spentUsd.toFixed(4)),
					// J-Space control telemetry: how much steering this model needed on
					// this task class. The diode made greppable.
					steers: result.control.steers,
					journalUpdates: result.control.journalUpdates,
					submitRejections: result.control.submitRejections,
					checkpoints: result.control.checkpoints,
				});

				return {
					content: [{ type: "text" as const, text: formatEnvelope(result) }],
					details: result,
					isError: isFailure(result),
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				auditSummon(BASE_DIR, {
					runId,
					depth: currentDepth,
					cwd,
					exitReason: "error",
					error: message,
					queueWaitMs,
				});
				return {
					content: [{ type: "text" as const, text: `mini ${runId} failed to start: ${message}` }],
					details: undefined,
					isError: true,
				};
			} finally {
				queueRelease?.();
				globalRelease();
				live.delete(controller);
				if (previousDepth === undefined) delete process.env[DEPTH_ENV];
				else process.env[DEPTH_ENV] = previousDepth;
			}
		},
	});

	// The TTY surface: `/mini` summons a run directly from the interactive
	// prompt — no parent-LLM turn, no tool-call round trip. The human writes
	// the brief; the runtime supplies the discipline.
	//
	//   /mini --band deep --steps 60 --accept "npm test -- retry" --lease "src/http/**"
	//         Fix the flaky retry in src/http/retry.ts
	//
	// Flags are optional; bare `/mini <task>` is a standard-band run.
	pi.registerCommand("mini", {
		description:
			"Summon a bounded sub-run (journal + submit gate + supervisor). " +
			"Flags: --band quick|standard|deep --model \"id-or-provider/id\" --steps N --usd X " +
			"--minutes N --accept \"cmd\" --lease \"globs,comma-sep\" --cwd PATH --off (no scout). " +
			"Rest is the brief. Default model: DeepSeek-V4-Flash-0731.",
		handler: async (args, ctx) => {
			const parsed = parseCommandArgs(args);
			if (!parsed.task) {
				ctx.ui.notify(
					"Usage: /mini [--band quick|standard|deep] [--steps N] [--usd X] [--minutes N] " +
						"[--accept \"cmd\"] [--lease \"g1,g2\"] [--cwd PATH] [--off] <task brief>",
					"warning",
				);
				return;
			}
			if (treeBudget.exhausted) {
				ctx.ui.notify(
					`mini: tree ceiling $${TREE_CEILING_USD.toFixed(2)} is spent ($${treeBudget.spentUsd.toFixed(2)}).`,
					"error",
				);
				return;
			}

			const runId = randomUUID().slice(0, 8);
			const limits = {
				steps: parsed.steps ?? DEFAULT_LIMITS.steps,
				usd: parsed.usd ?? DEFAULT_LIMITS.usd,
				wallMs: (parsed.minutes ?? DEFAULT_LIMITS.wallMs / 60000) * 60_000,
			};
			const controller = new AbortController();
			live.add(controller);
			const globalRelease = await semaphore.acquire();
			const resolved = resolveSummonModel(parsed.model, ctx.modelRegistry, ctx.model);
			ctx.ui.notify(
				`mini ${runId}: starting (${parsed.band ?? "standard"} band, ${resolved.id} [${resolved.source}], ` +
					`${limits.steps} steps / $${limits.usd.toFixed(2)} / ${Math.round(limits.wallMs / 60000)}m)`,
				"info",
			);

			const previousDepth = process.env[DEPTH_ENV];
			let queueRelease: (() => void) | undefined;
			let queueWaitMs = 0;
			let startedAt = Date.now();
			try {
				const queueStartedAt = Date.now();
				queueRelease = await providerQueue.acquire(summonQueueKey(resolved));
				queueWaitMs = Date.now() - queueStartedAt;
				startedAt = Date.now();
				process.env[DEPTH_ENV] = String(currentDepth + 1);
				const result = await runMiniAgent({
					task: parsed.task,
					cwd: parsed.cwd ?? ctx.cwd,
					limits,
					tree: treeBudget,
					baseDir: BASE_DIR,
					runId,
					model: resolved.model,
					retrieval: parsed.retrieval,
					accept: parsed.accept,
					lease: parsed.lease,
					band: parsed.band,
					signal: controller.signal,
				});

				const envelope = formatEnvelope(result);
				try {
					writeFileSync(join(BASE_DIR, "runs", runId, "envelope.md"), envelope, "utf-8");
				} catch {
					// best-effort artifact
				}
				const ttyModel = resolved.model;
				auditSummon(BASE_DIR, {
					runId,
					depth: currentDepth,
					cwd: parsed.cwd ?? ctx.cwd,
					task: parsed.task.slice(0, 400),
					model: ttyModel?.id ?? "tty-unknown",
					modelSource: resolved.source,
					provider: ttyModel?.provider,
					band: result.band,
					exitReason: result.exitReason,
					verified: result.verification ? result.verification.ok : "no-predicate",
					leaseViolations: result.leaseViolations?.length ?? 0,
					filesChanged: result.filesChanged.length,
					filesChangedSource: result.filesChangedSource,
					steps: result.steps,
					costUsd: Number(result.costUsd.toFixed(4)),
					elapsedMs: Date.now() - startedAt,
					queueWaitMs,
					treeSpentUsd: Number(treeBudget.spentUsd.toFixed(4)),
					steers: result.control.steers,
					journalUpdates: result.control.journalUpdates,
					submitRejections: result.control.submitRejections,
					checkpoints: result.control.checkpoints,
					surface: "tty",
				});

				const verdict = result.verification
					? result.verification.ok ? "verified PASS" : "verified FAIL"
					: result.exitReason;
				ctx.ui.notify(
					`mini ${runId}: ${verdict} · ${result.steps} steps · $${result.costUsd.toFixed(4)} · ` +
						`envelope ${join(BASE_DIR, "runs", runId, "envelope.md")}`,
					isFailure(result) ? "warning" : "info",
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				auditSummon(BASE_DIR, {
					runId,
					depth: currentDepth,
					cwd: ctx.cwd,
					exitReason: "error",
					error: message,
					queueWaitMs,
					surface: "tty",
				});
				ctx.ui.notify(`mini ${runId} failed to start: ${message}`, "error");
			} finally {
				queueRelease?.();
				globalRelease();
				live.delete(controller);
				if (previousDepth === undefined) delete process.env[DEPTH_ENV];
				else process.env[DEPTH_ENV] = previousDepth;
			}
		},
	});
}

interface CommandArgs {
	task: string;
	band?: Band;
	model?: string;
	steps?: number;
	usd?: number;
	minutes?: number;
	accept?: string;
	lease?: string[];
	cwd?: string;
	retrieval: "auto" | "off";
}

/** Shell-ish flag parsing for the /mini command: --flag value, \"--quoted\" values. */
function parseCommandArgs(args: string): CommandArgs {
	const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	const out: CommandArgs = { task: "", retrieval: "auto" };
	const rest: string[] = [];
	const unquote = (s: string) => s.replace(/^["']|["']$/g, "");
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		const next = () => unquote(tokens[++i] ?? "");
		switch (tok) {
			case "--band": {
				const b = next();
				if (b === "quick" || b === "standard" || b === "deep") out.band = b;
				break;
			}
			case "--steps": out.steps = Math.max(1, Number(next()) || 0); break;
			case "--usd": out.usd = Math.max(0.01, Number(next()) || 0); break;
			case "--minutes": out.minutes = Math.max(1, Number(next()) || 0); break;
			case "--model": out.model = next(); break;
			case "--accept": out.accept = next(); break;
			case "--lease": out.lease = next().split(",").map((s) => s.trim()).filter(Boolean); break;
			case "--cwd": out.cwd = next(); break;
			case "--off": out.retrieval = "off"; break;
			default: rest.push(tok);
		}
	}
	out.task = rest.join(" ").trim();
	return out;
}
