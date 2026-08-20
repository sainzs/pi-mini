/**
 * The submit gate — J-Space's bridge-before-conclusion, with the acceptance
 * predicate as harness-executed ground truth.
 *
 * v0.3 required an "observed acceptance pass" by CONTAINMENT-MATCHING the
 * child's `sh` command text against the caller's `accept` string and, on exit
 * 0, marking the run as having passed. That is gameable by construction:
 * `echo 'npm test'` exits 0 and contains the accept string, so the gate would
 * yield without the tests ever running. Same class of failure as a child
 * reporting "completed" having done nothing (see `verify.ts`, and the
 * 2026-08-07 multi-agent reorg run that shipped zero work).
 *
 * The fix is the same move verification already made: the HARNESS executes the
 * predicate. At submit time, if the caller declared `accept`, this module runs
 * it itself (`sh -c`, in the run cwd) and believes only an exit 0 it observed.
 * There is no callback, no command-text match, and no API to fake a pass.
 *
 * Yielding after `maxRejections` is unchanged: a child stuck in a gate loop
 * only burns budget, and the harness re-runs the predicate after the run
 * regardless, so ground truth is never the child's call. Gate-time executions
 * are themselves budgeted (`maxAcceptRuns`) so a failing predicate cannot be
 * used as a denial-of-service against the parent.
 */

import { execFileSync } from "node:child_process";

export type SubmitGateVerdict = { ok: true } | { ok: false; reason: string };

/** Sync or async; `createSubmitTool` awaits either. */
export type SubmitGate = () => SubmitGateVerdict | Promise<SubmitGateVerdict>;

export interface SubmitGateState {
	readonly rejections: number;
	readonly gateOverridden: boolean;
	readonly acceptRuns: number;
	readonly acceptObservedPass: boolean;
}

export interface SubmitGateOptions {
	hasVerified: () => boolean;
	accept?: string;
	cwd: string;
	maxRejections: number;
	/** Cap on gate-time `accept` executions. Default 2. */
	maxAcceptRuns?: number;
	/** Kill a hung accept command. Default 120_000 ms. */
	timeoutMs?: number;
}

const DEFAULT_MAX_ACCEPT_RUNS = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL = 400;

export function createSubmitGate(opts: SubmitGateOptions): {
	gate: () => SubmitGateVerdict;
	state: SubmitGateState;
} {
	const maxAcceptRuns = opts.maxAcceptRuns ?? DEFAULT_MAX_ACCEPT_RUNS;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let rejections = 0;
	let gateOverridden = false;
	let acceptRuns = 0;
	let acceptObservedPass = false;

	const state: SubmitGateState = {
		get rejections() {
			return rejections;
		},
		get gateOverridden() {
			return gateOverridden;
		},
		get acceptRuns() {
			return acceptRuns;
		},
		get acceptObservedPass() {
			return acceptObservedPass;
		},
	};

	const reject = (reason: string): SubmitGateVerdict => {
		rejections++;
		return { ok: false, reason };
	};

	const gate = (): SubmitGateVerdict => {
		// Already yielded: do not burn another accept run, do not re-check.
		if (rejections >= opts.maxRejections) {
			gateOverridden = true;
			return { ok: true };
		}

		if (!opts.hasVerified()) {
			return reject(
				"no journal `verified` entries. Bridge your conclusion to evidence: journal what you " +
					"proved, each entry naming the command output that proves it, then resubmit.",
			);
		}

		if (opts.accept) {
			if (acceptRuns >= maxAcceptRuns) {
				return reject("accept execution budget exhausted");
			}
			acceptRuns++;
			const result = runAccept(opts.accept, opts.cwd, timeoutMs);
			if (result.exitCode === 0) {
				acceptObservedPass = true;
				return { ok: true };
			}
			acceptObservedPass = false;
			const tail = tailOf(result.output);
			const detail = tail.length > 0 ? ` ${tail}` : "";
			return reject(
				`the acceptance command \`${opts.accept}\` exited ${result.exitCode ?? "none (did not run)"}.${detail}`,
			);
		}

		return { ok: true };
	};

	return { gate, state };
}

function tailOf(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= OUTPUT_TAIL) return trimmed;
	return trimmed.slice(trimmed.length - OUTPUT_TAIL);
}

function asText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Buffer.isBuffer(value)) return value.toString("utf-8");
	return "";
}

/**
 * Execute the caller's accept command. Exit 0 is the only pass; every other
 * outcome (nonzero, timeout, spawn failure) is a reject with whatever output
 * we caught.
 */
function runAccept(
	command: string,
	cwd: string,
	timeoutMs: number,
): { exitCode: number | null; output: string } {
	try {
		const stdout = execFileSync("sh", ["-c", command], {
			cwd,
			timeout: timeoutMs,
			encoding: "utf-8",
			maxBuffer: 4 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { exitCode: 0, output: stdout };
	} catch (cause) {
		const error = cause as {
			status?: number | null;
			code?: string | number;
			stdout?: string | Buffer;
			stderr?: string | Buffer;
			killed?: boolean;
			signal?: NodeJS.Signals | number | null;
		};
		const stdout = asText(error.stdout);
		const stderr = asText(error.stderr);
		const combined = `${stdout}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`;
		const timedOut =
			error.killed === true ||
			error.code === "ETIMEDOUT" ||
			(error.status === null && error.signal != null);
		if (timedOut) {
			return {
				exitCode: null,
				output: `[accept timed out after ${timeoutMs}ms] ${combined}`,
			};
		}
		const exitCode = typeof error.status === "number" ? error.status : null;
		return { exitCode, output: combined };
	}
}
