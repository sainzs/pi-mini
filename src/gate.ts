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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scrubEnv } from "./envscrub.ts";

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
const execFileAsync = promisify(execFile);

export function createSubmitGate(opts: SubmitGateOptions): {
	gate: SubmitGate;
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

	const gate = async (): Promise<SubmitGateVerdict> => {
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
			const result = await runAccept(opts.accept, opts.cwd, timeoutMs);
			if (result.exitCode === 0) {
				acceptObservedPass = true;
				return { ok: true };
			}
			acceptObservedPass = false;
			const details = [
				result.timedOut ? `[accept timed out after ${timeoutMs}ms]` : "",
				tailOf(result.output),
			].filter(Boolean);
			const detail = details.length > 0 ? ` ${details.join(" ")}` : "";
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
 *
 * Runs via `execFileAsync` (promisified `execFile`) with the event loop free;
 * a hung command receives `SIGKILL` at the timeout deadline via `killSignal`.
 * The run's child env is the scrubbed parent env (`scrubEnv(process.env)`) so
 * the acceptance predicate cannot read the run's credentials either.
 */
async function runAccept(
	command: string,
	cwd: string,
	timeoutMs: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
	try {
		const { stdout } = await execFileAsync("sh", ["-c", command], {
			cwd,
			env: scrubEnv(process.env),
			timeout: timeoutMs,
			encoding: "utf-8",
			maxBuffer: 4 * 1024 * 1024,
			killSignal: "SIGKILL",
		});
		return { exitCode: 0, output: asText(stdout), timedOut: false };
	} catch (cause) {
		const error = cause as {
			code?: string | number;
			stdout?: string | Buffer;
			stderr?: string | Buffer;
			killed?: boolean;
		};
		const stdout = asText(error.stdout);
		const stderr = asText(error.stderr);
		const combined = `${stdout}${stderr ? `${stdout ? "\n" : ""}${stderr}` : ""}`;
		const timedOut = error.killed === true || error.code === "ETIMEDOUT";
		if (timedOut) {
			return {
				exitCode: null,
				output: combined,
				timedOut: true,
			};
		}
		const exitCode = typeof error.code === "number" ? error.code : null;
		return { exitCode, output: combined, timedOut: false };
	}
}
