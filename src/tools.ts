/**
 * The runtime's tools: `sh`, `submit`, and optionally `locate`.
 *
 * There is exactly one action tool. Not to save schema tokens — measured, that
 * is worth ~4.8% of a cached run — but because one action per step is what makes
 * step accounting honest, keeps the transcript linear, and removes parallel
 * tool-call fan-out from the failure surface.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	createBashToolDefinition,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Budget } from "./budget.ts";
import type { CheckpointRecorder } from "./checkpoints.ts";
import type { SubmitGate } from "./gate.ts";
import { recordObservation, type RunLedger } from "./ledger.ts";
import type { Supervisor } from "./supervisor.ts";

export type { SubmitGate } from "./gate.ts";

const execFileAsync = promisify(execFile);

/**
 * Default `sh` timeout in seconds.
 *
 * pi's bash tool documents "no default timeout". For an unattended run that is a
 * cost bug as much as a hang risk: Anthropic's default cache TTL is 5 minutes
 * (pi's `getCacheControl()` uses the "short" retention unless
 * `PI_CACHE_RETENTION=long`), so one 6-minute `cargo build` silently drops the
 * cached prefix. Measured price of a single miss at step 30 of a 40-step Opus
 * run: $0.14 on a $0.84 run — 17%.
 */
const DEFAULT_SH_TIMEOUT_SECONDS = 120;

export interface ShToolInput {
	cwd: string;
	budget: Budget;
	ledger: RunLedger;
	/** Prefix applied to every command — used for output hygiene (PAGER=cat etc). */
	commandPrefix?: string;
	/** J-Space control plane: stall detection + steering nudges. */
	supervisor?: Supervisor;
	/** Diff snapshots after write-ish commands. */
	checkpoints?: CheckpointRecorder;
	/** Step of the last journal write, for staleness nudges. */
	lastJournalStep?: () => number;
}

/**
 * Environment hygiene, borrowed from mini-swe-agent's `config/default.yaml`.
 * Progress bars and pagers produce enormous, worthless observations.
 */
export const SH_COMMAND_PREFIX = [
	"export PAGER=cat GIT_PAGER=cat",
	"export TQDM_DISABLE=1 PIP_PROGRESS_BAR=off",
	"export CI=1 NO_COLOR=1 TERM=dumb",
].join("\n");

/**
 * `sh` — pi's own bash tool, wrapped.
 *
 * Wrapping rather than reimplementing keeps detached process groups, tree kill
 * on abort, output truncation and temp-file spill (`src/core/tools/bash.ts`) —
 * all of which are already correct. We add exactly two things: a mandatory
 * timeout, and ledger-backed elision.
 */
export function createShTool(input: ShToolInput): ToolDefinition {
	const { cwd, budget, ledger, commandPrefix, supervisor, checkpoints, lastJournalStep } = input;
	const base = createBashToolDefinition(cwd, { commandPrefix, exposeSessionEnvironment: false });

	return {
		...base,
		name: "sh",
		label: "sh",
		description:
			"Run one shell command in the working directory and return its output. " +
			`Always pass \`timeout\` for builds, tests and installs; it defaults to ${DEFAULT_SH_TIMEOUT_SECONDS}s. ` +
			"Long output is elided in your context but written in full to a file whose path is shown.",
		promptSnippet: "Run one shell command per step",
		promptGuidelines: undefined,

		async execute(toolCallId, args, signal, onUpdate, ctx) {
			const params = args as { command: string; timeout?: number };
			const withTimeout = {
				...params,
				timeout: params.timeout ?? DEFAULT_SH_TIMEOUT_SECONDS,
			};

			const result = await base.execute(toolCallId, withTimeout as never, signal, onUpdate, ctx);

			// The supervisor sees every command: stall signals, and whether this
			// step plausibly moved the work tree (→ checkpoint). Acceptance is
			// no longer inferred from command text — the submit gate executes
			// the predicate itself (see `gate.ts`).
			const writeish = supervisor?.noteCommand(params.command) ?? false;
			if (writeish && checkpoints?.active) {
				await checkpoints.maybeSnapshot(budget.steps);
			}

			// Route the text through the ledger, then append the budget nudge so the
			// model can choose to submit rather than be cut off.
			const content = (result.content ?? []).map((block) => {
				if (block.type !== "text") return block;
				return { ...block, text: recordObservation(ledger, budget.steps, block.text) };
			});

			// J-Space steering rides the tail of the observation the model is about
			// to read: one cache-write increment, no extra turn.
			const nudge = supervisor?.nudge(budget.steps, lastJournalStep?.() ?? -1);
			if (nudge) content.push({ type: "text" as const, text: `\n${nudge.text}` });

			const warning = budget.warningLine();
			if (warning) content.push({ type: "text" as const, text: `\n${warning}` });

			return { ...result, content };
		},
	} as ToolDefinition;
}

export interface SubmitDetails {
	summary: string;
	filesChanged: string[];
}

/**
 * `submit` — the explicit submission contract.
 *
 * mini-swe-agent's best idea. Scraping the last assistant message is
 * unreliable; a required terminating tool call makes the result machine-checkable
 * and lets the run end without paying for another LLM turn (`terminate: true`).
 */
export function createSubmitTool(
	onSubmit: (details: SubmitDetails) => void,
	gate?: SubmitGate,
	onRejected?: () => void,
): ToolDefinition {
	return defineTool({
		name: "submit",
		label: "submit",
		description:
			"Report your final result and end the run. Call this exactly once, as your last action. " +
			"The run must be bridged to evidence first: at least one journal `verified` entry, and — when " +
			"an acceptance command was declared — the harness will execute it at submit time and require " +
			"exit 0. A rejected submit does not end the run; fix what it names and resubmit. If you are " +
			"out of budget, submit whatever you have verified so far rather than nothing.",
		promptSnippet: "Report the final result and end the run",
		parameters: Type.Object({
			summary: Type.String({
				description:
					"What you did, what you verified, and anything the caller must know. Include concrete " +
					"file:line references. State plainly what you could not finish.",
			}),
			filesChanged: Type.Optional(
				Type.Array(Type.String(), {
					description: "Repo-relative paths you created or modified. Empty for read-only work.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const verdict = (await gate?.()) ?? { ok: true as const };
			if (!verdict.ok) {
				onRejected?.();
				return {
					content: [
						{
							type: "text" as const,
							text:
								`SUBMIT REJECTED — ${verdict.reason}\n` +
								"Fix exactly that, then call submit again. This rejection does not consume your result; " +
								"nothing has been reported to the caller yet.",
						},
					],
					details: undefined,
					isError: true,
				};
			}
			const details: SubmitDetails = {
				summary: params.summary,
				filesChanged: params.filesChanged ?? [],
			};
			onSubmit(details);
			return {
				content: [{ type: "text", text: "Result submitted. Run complete." }],
				details,
				terminate: true,
			};
		},
	}) as unknown as ToolDefinition;
}

/** Is Scout available *and* is this exact directory indexed? */
export async function scoutCanServe(cwd: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("scout", ["list"], { timeout: 5_000 });
		return stdout.split("\n").some((line) => line.trim().startsWith(cwd));
	} catch {
		return false;
	}
}

const LOCATE_MAX_RESULTS = 14;

/**
 * Reduce `scout search` output to locations.
 *
 * Raw scout output is 1,700–2,600 tokens per call and opens with a
 * "### Prior knowledge from memory / treat it as authoritative" preamble plus
 * full code snippets. Two problems: at that size the call has to save 3+ steps
 * to break even, and the preamble is both harness chatter and an instruction we
 * did not write. Locations only lands at ~300 tokens, which breaks even in under
 * one saved step — and the agent reads the code itself with `sh`, in context.
 */
export function extractLocations(raw: string, max = LOCATE_MAX_RESULTS): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	// `12. path/to/file.ts (lines 218-236, 1.00) [repo]`
	const ranked = /^\s*\d+\.\s+(\S+)\s+\(lines\s+(\d+)-(\d+)/;
	for (const line of raw.split("\n")) {
		const m = ranked.exec(line);
		if (!m) continue;
		const key = `${m[1]}:${m[2]}-${m[3]}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(key);
		if (out.length >= max) break;
	}
	return out;
}

export function createLocateTool(cwd: string): ToolDefinition {
	return defineTool({
		name: "locate",
		label: "locate",
		description:
			"Semantic search of this repository. Returns `path:startLine-endLine` locations only — read " +
			"them with `sh`. Use when you do not know where something lives; use `sh` with `rg` when you " +
			"know the exact string.",
		promptSnippet: "Semantically locate code by description",
		parameters: Type.Object({
			query: Type.String({ description: "What you are looking for, in plain language." }),
		}),
		async execute(_toolCallId, params, signal) {
			try {
				const { stdout } = await execFileAsync("scout", ["search", params.query], {
					cwd,
					timeout: 20_000,
					maxBuffer: 8 * 1024 * 1024,
					signal: signal as AbortSignal | undefined,
				});
				const locations = extractLocations(stdout);
				const text = locations.length
					? `${locations.length} location(s):\n${locations.join("\n")}`
					: "No matches. Fall back to `sh` with `rg`.";
				return { content: [{ type: "text" as const, text }], details: undefined };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text" as const,
							text: `locate unavailable (${message}). Use \`sh\` with \`rg\`.`,
						},
					],
					details: undefined,
				};
			}
		},
	}) as unknown as ToolDefinition;
}
