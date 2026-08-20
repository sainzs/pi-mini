/**
 * pi-mini's own eval harness — the README's model claims become reproducible
 * measurements instead of a third-party report's self-reported numbers.
 *
 *   node --experimental-strip-types scripts/eval.ts [--model provider/id] [--tasks id,id] [--dry-run]
 *
 * Each task in eval/tasks/ is self-contained: its setup commands build a
 * fixture into a fresh tmp git repo (no network), then the harness runs the
 * brief through runMiniAgent and records the envelope — exitReason, steps,
 * costUsd, steers, journalUpdates, submitRejections, throttledRetries,
 * gateOverridden — plus the accept verdict. The accept command is executed by
 * harnesses, never trusted from the model: once by the runner after the child
 * ends (the envelope's `verification`) and once again here (`acceptRerun`) —
 * the same move the submit gate made in gate.ts, because any self-report is
 * data, not ground truth.
 *
 * Rows land in eval/results/<model>-<stamp>.ndjson with a rendered markdown
 * table beside it; README default-model claims cite those artifacts.
 *
 * --dry-run builds every fixture and validates the task definitions and
 * accept predicates WITHOUT calling a model: each accept must run to a real
 * exit code, and must FAIL on the pristine fixture — a predicate that passes
 * before any work measures nothing. That is the CI-safe gate; live runs are
 * scheduled separately (cost and rate limits).
 */

import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { TreeBudget } from "../src/budget.ts";
import type { RunResult } from "../src/envelope.ts";
import { type Band, runMiniAgent } from "../src/runner.ts";
import { runAcceptance, type Verification } from "../src/verify.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tasksDir = join(repoRoot, "eval", "tasks");
const resultsDir = join(repoRoot, "eval", "results");

/** The README's default — evaluating anything else must name it explicitly. */
const DEFAULT_MODEL = "azure-foundry/DeepSeek-V4-Flash-0731";
/** Matches the PI_MINI_TREE_USD default: one ceiling for the whole sweep. */
const TREE_CEILING_USD = 25;

const USAGE = `usage: node --experimental-strip-types scripts/eval.ts [--model provider/id] [--tasks id,id] [--dry-run]

  --model provider/id   model to evaluate (default: ${DEFAULT_MODEL})
  --tasks id,id         comma-separated task ids (default: every eval/tasks/*.json)
  --dry-run             build fixtures and validate task JSON + accept commands; no model calls
`;

type ExpectKind = "accept-pass" | "investigation" | "no-false-claim";

interface TaskDef {
	id: string;
	brief: string;
	setup: string[];
	accept?: string;
	lease?: string[];
	band: Band;
	limits: { steps: number; usd: number; wallMs: number };
	expect: { kind: ExpectKind; minVerified?: number };
}

const BANDS = new Set<string>(["quick", "standard", "deep"]);
const EXPECT_KINDS = new Set<string>(["accept-pass", "investigation", "no-false-claim"]);

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Structural validation only; fixture/accept behaviour is proven by --dry-run. */
function validateTask(file: string, raw: unknown): { task?: TaskDef; errors: string[] } {
	const errors: string[] = [];
	const t = (raw ?? {}) as Record<string, unknown>;

	if (typeof t.id !== "string" || !/^[0-9a-z-]+$/.test(t.id)) {
		errors.push(`${file}: id must match /^[0-9a-z-]+$/`);
	}
	if (!isNonEmptyString(t.brief)) errors.push(`${file}: brief must be a non-empty string`);

	const setup = Array.isArray(t.setup) ? t.setup : [];
	if (setup.length === 0 || !setup.every(isNonEmptyString)) {
		errors.push(`${file}: setup must be a non-empty array of shell commands`);
	}

	if (t.accept !== undefined && !isNonEmptyString(t.accept)) {
		errors.push(`${file}: accept, when present, must be a non-empty string`);
	}

	const lease = t.lease === undefined ? undefined : Array.isArray(t.lease) ? t.lease : undefined;
	if (t.lease !== undefined && (lease === undefined || !lease.every(isNonEmptyString))) {
		errors.push(`${file}: lease must be an array of glob strings`);
	}

	if (!BANDS.has(t.band as string)) {
		errors.push(`${file}: band must be quick | standard | deep`);
	}

	const limits = (t.limits ?? {}) as Record<string, unknown>;
	for (const key of ["steps", "usd", "wallMs"] as const) {
		if (!isPositiveNumber(limits[key])) {
			errors.push(`${file}: limits.${key} must be a positive number`);
		}
	}

	const expect = (t.expect ?? {}) as Record<string, unknown>;
	const kind = expect.kind as string;
	if (!EXPECT_KINDS.has(kind)) {
		errors.push(`${file}: expect.kind must be accept-pass | investigation | no-false-claim`);
	}
	if (expect.minVerified !== undefined) {
		const minVerified = expect.minVerified;
		if (typeof minVerified !== "number" || !Number.isInteger(minVerified) || minVerified < 1) {
			errors.push(`${file}: expect.minVerified must be a positive integer`);
		}
	}

	// Cross-field invariants, per task class: an investigation is judged by the
	// submit and the journal, so it declares neither accept nor lease.
	if (kind === "investigation") {
		if (t.accept !== undefined) {
			errors.push(`${file}: an investigation task declares no accept; it is judged by submit + journal verified count`);
		}
		if (t.lease !== undefined) {
			errors.push(`${file}: an investigation task declares no lease (read-only)`);
		}
	}
	if ((kind === "accept-pass" || kind === "no-false-claim") && t.accept === undefined) {
		errors.push(`${file}: kind ${kind} requires an accept command`);
	}

	if (errors.length > 0) return { errors };
	return {
		errors,
		task: {
			id: t.id as string,
			brief: (t.brief as string).trim(),
			setup: setup.map((command) => command.trim()),
			...(t.accept !== undefined ? { accept: (t.accept as string).trim() } : {}),
			...(lease ? { lease: lease.map((pattern) => pattern.trim()) } : {}),
			band: t.band as Band,
			limits: {
				steps: limits.steps as number,
				usd: limits.usd as number,
				wallMs: limits.wallMs as number,
			},
			expect: {
				kind: kind as ExpectKind,
				...(expect.minVerified !== undefined ? { minVerified: expect.minVerified as number } : {}),
			},
		},
	};
}

function loadTasks(only?: string[]): { tasks: TaskDef[]; errors: string[] } {
	const errors: string[] = [];
	const tasks: TaskDef[] = [];
	let files: string[];
	try {
		files = readdirSync(tasksDir)
			.filter((name) => name.endsWith(".json"))
			.sort();
	} catch (error) {
		return {
			tasks,
			errors: [`cannot read ${tasksDir}: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
	const seen = new Set<string>();
	for (const file of files) {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(join(tasksDir, file), "utf8"));
		} catch (error) {
			errors.push(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
			continue;
		}
		const { task, errors: taskErrors } = validateTask(file, raw);
		errors.push(...taskErrors);
		if (!task) continue;
		if (seen.has(task.id)) {
			errors.push(`${file}: duplicate task id ${task.id}`);
			continue;
		}
		seen.add(task.id);
		tasks.push(task);
	}
	if (only) {
		const unknown = only.filter((id) => !seen.has(id));
		if (unknown.length > 0) {
			errors.push(`unknown task id(s): ${unknown.join(", ")} — available: ${[...seen].sort().join(", ")}`);
		}
		return { tasks: tasks.filter((task) => only.includes(task.id)), errors };
	}
	return { tasks, errors };
}

interface Cli {
	model: string;
	tasks?: string[];
	dryRun: boolean;
	help: boolean;
	error?: string;
}

function parseArgs(argv: string[]): Cli {
	const cli: Cli = { model: DEFAULT_MODEL, dryRun: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const eq = argv[i].indexOf("=");
		const flag = eq === -1 ? argv[i] : argv[i].slice(0, eq);
		const inline = eq === -1 ? undefined : argv[i].slice(eq + 1);
		if (flag === "--dry-run") {
			cli.dryRun = true;
		} else if (flag === "--help" || flag === "-h") {
			cli.help = true;
		} else if (flag === "--model" || flag === "--tasks") {
			const value = inline ?? argv[i + 1];
			if (inline === undefined) i++;
			if (value === undefined) {
				cli.error = `${flag} requires a value`;
				break;
			}
			if (flag === "--model") cli.model = value;
			else cli.tasks = value.split(",").map((id) => id.trim()).filter(Boolean);
		} else {
			cli.error = `unknown argument: ${argv[i]}`;
			break;
		}
	}
	return cli;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** Same stamp shape as release-check, so artifacts sort together. */
function timestamp(date: Date): string {
	return (
		[date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("") +
		`-${pad(date.getHours())}${pad(date.getMinutes())}`
	);
}

function sanitizeModelSpec(spec: string): string {
	return spec.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * Materialize one fixture: a fresh directory under `root`, the task's setup
 * commands in order, then proof that the result is a git work tree — lease
 * observation and checkpoints both depend on it.
 */
function buildFixture(root: string, task: TaskDef): string {
	const dir = join(root, task.id);
	mkdirSync(dir);
	for (const command of task.setup) {
		try {
			execFileSync("bash", ["-c", command], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			const failure = error as { status?: number; stderr?: Buffer };
			const stderr = failure.stderr?.toString().trim();
			throw new Error(
				`setup command failed (exit ${failure.status ?? "?"}) for ${task.id}: ${command}` +
					(stderr ? `\n${stderr}` : ""),
			);
		}
	}
	try {
		execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: dir,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		throw new Error(`${task.id}: setup did not produce a git work tree`);
	}
	return dir;
}

interface DryRow {
	id: string;
	band: Band;
	ok: boolean;
	detail: string;
}

/**
 * The CI-safe gate. Builds every fixture and proves each accept command is
 * runnable (produces an exit code) and discriminating (FAILS on the pristine
 * fixture — a predicate green before any work measures nothing). No model is
 * ever constructed here.
 */
async function dryRun(tasks: TaskDef[]): Promise<number> {
	const root = mkdtempSync(join(tmpdir(), "mini-eval-dry-"));
	console.log(`eval dry-run — ${tasks.length} task(s), no model calls\n`);
	const rows: DryRow[] = [];
	for (const task of tasks) {
		const problems: string[] = [];
		const notes: string[] = [];
		let fixtureDir: string | undefined;
		try {
			fixtureDir = buildFixture(root, task);
			notes.push("fixture built, git work tree ok");
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
		if (fixtureDir && task.accept) {
			const verdict = await runAcceptance(task.accept, fixtureDir);
			if (verdict.exitCode === null) {
				problems.push(`accept did not run to an exit code: ${verdict.output || "spawn failure or timeout"}`);
			} else if (verdict.ok) {
				problems.push("accept PASSED on the pristine fixture — the predicate measures nothing");
			} else {
				notes.push(`accept runnable (pristine exit ${verdict.exitCode}, non-zero as required)`);
			}
		} else if (!task.accept) {
			notes.push("no accept (judged by submit + journal verified count)");
		}
		const ok = problems.length === 0;
		const row: DryRow = {
			id: task.id,
			band: task.band,
			ok,
			detail: ok ? notes.join(" · ") : problems.join(" | "),
		};
		rows.push(row);
		console.log(`${ok ? "PASS" : "FAIL"} ${row.id} [${row.band}]  ${row.detail}`);
	}
	const failed = rows.filter((row) => !row.ok);
	console.log(`\ndry-run: ${rows.length - failed.length}/${rows.length} tasks valid`);
	console.log(`fixture root (kept for inspection): ${root}`);
	return failed.length === 0 ? 0 : 1;
}

/** One ndjson row: the envelope fields plus the harness's own accept re-run. */
interface EvalRow {
	task: string;
	model: string;
	band: Band;
	exitReason: string;
	steps: number;
	costUsd: number;
	steers: number;
	steersDetail: { repeat: number; inertia: number; journal: number };
	journalUpdates: number;
	verifiedEntries: number;
	submitRejections: number;
	throttledRetries: number;
	gateOverridden: boolean;
	runnerVerified: boolean | null;
	acceptRerun: boolean | null;
	leaseViolations: string[];
	filesChanged: string[];
	filesChangedSource: string;
	pass: boolean;
	reason: string;
	durationMs: number;
	ledgerDir?: string;
	error?: string;
}

/** The per-task contract: what has to be true for this task class to pass. */
function judge(task: TaskDef, result: RunResult, rerun?: Verification): { pass: boolean; reason: string } {
	const fail = (reason: string) => ({ pass: false, reason });
	switch (task.expect.kind) {
		case "accept-pass": {
			if (result.exitReason !== "submitted") {
				return fail(`exit ${result.exitReason}, expected submitted`);
			}
			const violations = result.leaseViolations ?? [];
			if (violations.length > 0) {
				return fail(`lease violations: ${violations.join(", ")}`);
			}
			if (result.verification?.ok !== true) {
				return fail(`runner-side accept exited ${result.verification?.exitCode ?? "n/a (predicate did not run)"}`);
			}
			if (rerun?.ok !== true) {
				return fail(`harness accept re-run exited ${rerun?.exitCode ?? "n/a (predicate did not run)"}`);
			}
			return { pass: true, reason: "submitted; accept verified by runner and re-run by harness" };
		}
		case "investigation": {
			const min = task.expect.minVerified ?? 1;
			if (result.exitReason !== "submitted") {
				return fail(`exit ${result.exitReason}, expected submitted`);
			}
			if (result.control.verifiedEntries < min) {
				return fail(`${result.control.verifiedEntries} verified journal entries, required >= ${min}`);
			}
			if (result.filesChangedSource === "observed" && result.filesChanged.length > 0) {
				return fail(`read-only task changed files: ${result.filesChanged.join(", ")}`);
			}
			return {
				pass: true,
				reason: `submitted read-only with ${result.control.verifiedEntries} verified journal entries`,
			};
		}
		case "no-false-claim": {
			// The accept command cannot pass, so a submit only ever lands through
			// gate override. PASS = the run ended on budget/error with the gate
			// intact: no false claim was reported.
			const noClaim = result.exitReason === "step_limit" || result.exitReason === "error";
			const cleanGate = result.control.gateOverridden !== true;
			if (noClaim && cleanGate) {
				return { pass: true, reason: `no false claim: ${result.exitReason}, gate intact` };
			}
			return fail(
				`exitReason=${result.exitReason}, gateOverridden=${result.control.gateOverridden === true}` +
					(result.control.gateOverridden === true ? " (the gate yielded and an unverified claim went through)" : ""),
			);
		}
	}
	// Unreachable: ExpectKind is exhaustive. Kept as a guard against a future
	// kind being added to the type without a judge branch.
	throw new Error(`unknown expect kind: ${String((task.expect as { kind: unknown }).kind)}`);
}

function verdictText(value: boolean | null): string {
	return value === null ? "—" : value ? "PASS" : "FAIL";
}

function renderMarkdown(
	modelSpec: string,
	stamp: string,
	rows: EvalRow[],
	ndjsonPath: string,
	fixtureRoot: string,
	ledgerRoot: string,
): string {
	const passed = rows.filter((row) => row.pass).length;
	const lines = [
		`# pi-mini eval — ${modelSpec}`,
		"",
		`- Stamp: ${stamp}`,
		`- Tasks: ${rows.length} · passed: ${passed}`,
		`- Fixtures: \`${fixtureRoot}\` (ephemeral tmp)`,
		`- Ledgers: \`${ledgerRoot}\` (ephemeral tmp; transcripts and journals per task)`,
		`- Rows: \`${ndjsonPath.replace(`${repoRoot}/`, "")}\``,
		"",
		"| Task | Band | Exit | Steps | Cost | Steers | Journal | Submit rej. | Throttled | Gate | Accept (runner · harness) | Verdict |",
		"| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
	];
	for (const row of rows) {
		const accept =
			row.runnerVerified === null && row.acceptRerun === null
				? "—"
				: `${verdictText(row.runnerVerified)} · ${verdictText(row.acceptRerun)}`;
		lines.push(
			`| ${row.task} | ${row.band} | ${row.exitReason} | ${row.steps} | $${row.costUsd.toFixed(4)} | ` +
				`${row.steers} | ${row.journalUpdates} | ${row.submitRejections} | ${row.throttledRetries} | ` +
				`${row.gateOverridden ? "OVERRIDDEN" : "clean"} | ${accept} | ${row.pass ? "PASS" : "FAIL"} |`,
		);
	}
	const failures = rows.filter((row) => !row.pass);
	if (failures.length > 0) {
		lines.push("", "## Failures", "");
		for (const row of failures) lines.push(`- **${row.task}**: ${row.reason}`);
	}
	lines.push(
		"",
		`Generated by \`scripts/eval.ts\` (\`npm run eval -- --model ${modelSpec}\`). ` +
			"README default-model claims cite this artifact.",
		"",
	);
	return lines.join("\n");
}

async function runLive(tasks: TaskDef[], modelSpec: string): Promise<number> {
	const [provider, ...rest] = modelSpec.split("/");
	const modelId = rest.join("/");
	if (!provider || !modelId) {
		console.error(`bad model spec: ${modelSpec} (want provider/id)`);
		return 1;
	}
	const runtime = await ModelRuntime.create();
	const model = runtime.getModel(provider, modelId);
	if (!model) {
		console.error(`no such model: ${modelSpec}`);
		return 1;
	}

	const stamp = timestamp(new Date());
	mkdirSync(resultsDir, { recursive: true });
	const baseName = `${sanitizeModelSpec(modelSpec)}-${stamp}`;
	const ndjsonPath = join(resultsDir, `${baseName}.ndjson`);
	const mdPath = join(resultsDir, `${baseName}.md`);
	const fixtureRoot = mkdtempSync(join(tmpdir(), "mini-eval-fixture-"));
	const ledgerRoot = mkdtempSync(join(tmpdir(), "mini-eval-ledger-"));
	const tree = new TreeBudget(TREE_CEILING_USD);

	console.log(`model: ${modelSpec}`);
	console.log(`fixtures: ${fixtureRoot}`);
	console.log(`ledgers: ${ledgerRoot}\n`);

	const rows: EvalRow[] = [];
	for (const task of tasks) {
		console.log(`--- ${task.id} [${task.band}] ---`);
		const startedAt = Date.now();
		let fixtureDir = "";
		let harnessError: string | undefined;
		let result: RunResult | undefined;
		try {
			fixtureDir = buildFixture(fixtureRoot, task);
		} catch (error) {
			harnessError = `fixture setup failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (!harnessError) {
			try {
				result = await runMiniAgent({
					task: task.brief,
					cwd: fixtureDir,
					limits: task.limits,
					tree,
					baseDir: ledgerRoot,
					runId: task.id,
					model,
					modelRuntime: runtime,
					retrieval: "off",
					...(task.accept ? { accept: task.accept } : {}),
					...(task.lease ? { lease: task.lease } : {}),
					band: task.band,
					onProgress: (text) => console.log(`    ${text}`),
				});
			} catch (error) {
				harnessError = error instanceof Error ? error.message : String(error);
			}
		}
		// The harness's own verdict, independent of the runner's self-report.
		let rerun: Verification | undefined;
		if (!harnessError && task.accept) {
			try {
				rerun = await runAcceptance(task.accept, fixtureDir);
			} catch (error) {
				harnessError = `accept re-run failed to execute: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		const durationMs = Date.now() - startedAt;

		const verdict = result
			? judge(task, result, rerun)
			: { pass: false, reason: harnessError ?? "run produced no result" };
		const row: EvalRow = {
			task: task.id,
			model: modelSpec,
			band: task.band,
			exitReason: result?.exitReason ?? "harness_error",
			steps: result?.steps ?? 0,
			costUsd: result?.costUsd ?? 0,
			steers: result
				? result.control.steers.repeat + result.control.steers.inertia + result.control.steers.journal
				: 0,
			steersDetail: result?.control.steers ?? { repeat: 0, inertia: 0, journal: 0 },
			journalUpdates: result?.control.journalUpdates ?? 0,
			verifiedEntries: result?.control.verifiedEntries ?? 0,
			submitRejections: result?.control.submitRejections ?? 0,
			throttledRetries: result?.control.throttledRetries ?? 0,
			gateOverridden: result?.control.gateOverridden === true,
			runnerVerified: result?.verification ? result.verification.ok : null,
			acceptRerun: rerun ? rerun.ok : null,
			leaseViolations: result?.leaseViolations ?? [],
			filesChanged: result?.filesChanged ?? [],
			filesChangedSource: result?.filesChangedSource ?? "none",
			pass: verdict.pass,
			reason: verdict.reason,
			durationMs,
			...(result?.ledgerDir ? { ledgerDir: result.ledgerDir } : {}),
			...(result?.error ? { error: result.error } : {}),
			...(harnessError ? { error: harnessError } : {}),
		};
		rows.push(row);
		appendFileSync(ndjsonPath, `${JSON.stringify(row)}\n`, "utf8");
		console.log(
			`    => ${row.pass ? "PASS" : "FAIL"} — ${row.reason} ` +
				`(${row.exitReason}, ${row.steps} steps, $${row.costUsd.toFixed(4)}, ${(durationMs / 1000).toFixed(1)}s)\n`,
		);
	}

	const md = renderMarkdown(modelSpec, stamp, rows, ndjsonPath, fixtureRoot, ledgerRoot);
	writeFileSync(mdPath, md, "utf8");
	console.log(md);
	const failed = rows.filter((row) => !row.pass);
	console.log(`eval: ${rows.length - failed.length}/${rows.length} tasks passed`);
	console.log(`artifacts: ${ndjsonPath}\n           ${mdPath}`);
	return failed.length === 0 ? 0 : 1;
}

const cli = parseArgs(process.argv.slice(2));
if (cli.help) {
	console.log(USAGE);
	process.exit(0);
}
if (cli.error) {
	console.error(`${cli.error}\n\n${USAGE}`);
	process.exit(1);
}
const { tasks, errors } = loadTasks(cli.tasks);
if (errors.length > 0) {
	for (const error of errors) console.error(`task error: ${error}`);
	process.exit(1);
}
if (tasks.length === 0) {
	console.error("no tasks selected");
	process.exit(1);
}
process.exitCode = cli.dryRun ? await dryRun(tasks) : await runLive(tasks, cli.model);
