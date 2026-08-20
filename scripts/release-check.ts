/**
 * Release evidence runner. Every check is executed directly with
 * `execFileSync`, never through a shell pipeline, so the recorded exit code is
 * the check's exit code rather than a pipe's final command.
 *
 *   npm run release-check                 # typecheck + tests
 *   npm run release-check -- --live       # also run the paid live smokes
 *
 * Each run archives the commands' complete stdout/stderr under findings/.
 * The live pair is separated by 75 seconds because the zero-priced Foundry
 * deployment rate-limits bursts. A release claim is only as fresh as this
 * evidence, so version bumps require a new release artifact.
 */

import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const findingsRoot = join(repoRoot, "findings");
const live = process.argv.slice(2).includes("--live");
const smokeModels = [
	"azure-foundry-claude/claude-fable-5",
	"azure-foundry/DeepSeek-V4-Flash-0731",
] as const;

type CheckResult = {
	step: number;
	name: string;
	command: string;
	logPath: string;
	exitCode: number | null;
	durationMs: number;
	status: "PASS" | "FAIL" | "SKIPPED";
	failureReason?: string;
};

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function timestamp(date: Date): string {
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
	].join("-") + `-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function createFindingsDir(): string {
	mkdirSync(findingsRoot, { recursive: true });
	const baseName = `release-${timestamp(new Date())}`;

	for (let attempt = 0; ; attempt++) {
		const suffix = attempt === 0 ? "" : `-${attempt}`;
		const directory = join(findingsRoot, `${baseName}${suffix}`);
		try {
			mkdirSync(directory);
			return directory;
		} catch (error) {
			if ((error as { code?: string }).code !== "EEXIST") {
				throw error;
			}
		}
	}
}

function quoteArgument(argument: string): string {
	return /^[A-Za-z0-9_./:@+-]+$/.test(argument) ? argument : JSON.stringify(argument);
}

function commandText(executable: string, args: string[]): string {
	return [executable, ...args].map(quoteArgument).join(" ");
}

function logPath(findingsDir: string, step: number, name: string): string {
	return join(findingsDir, `${pad(step)}-${name}.log`);
}

function runCommand(
	findingsDir: string,
	step: number,
	name: string,
	executable: string,
	args: string[],
	displayCommand = commandText(executable, args),
): CheckResult {
	const outputPath = logPath(findingsDir, step, name);
	const startedAt = Date.now();
	writeFileSync(outputPath, `command: ${displayCommand}\n\noutput:\n`, "utf8");
	console.log(`step ${step}: ${displayCommand}`);

	let exitCode: number | null = 0;
	let failureReason: string | undefined;
	let outputFd: number | undefined;
	try {
		outputFd = openSync(outputPath, "a");
		try {
			execFileSync(executable, args, {
				cwd: repoRoot,
				maxBuffer: 64 * 1024 * 1024,
				stdio: ["ignore", outputFd, outputFd],
			});
		} catch (error) {
			const childError = error as {
				message?: string;
				signal?: string | null;
				status?: number | null;
			};
			exitCode = typeof childError.status === "number" ? childError.status : null;
			failureReason = childError.signal
				? `terminated by signal ${childError.signal}`
				: childError.message ?? "child process failed to start";
			appendFileSync(outputPath, `\n\nprocess error: ${failureReason}\n`, "utf8");
		}
	} catch (error) {
		exitCode = null;
		failureReason = error instanceof Error ? error.message : String(error);
		appendFileSync(outputPath, `\n\nrelease-check error: ${failureReason}\n`, "utf8");
	} finally {
		if (outputFd !== undefined) {
			closeSync(outputFd);
		}
	}

	const durationMs = Date.now() - startedAt;
	const status = exitCode === 0 ? "PASS" : "FAIL";
	appendFileSync(
		outputPath,
		[
			"",
			"--- release-check record ---",
			`exit code: ${exitCode ?? "n/a"}`,
			`duration: ${durationMs} ms`,
			`status: ${status}`,
			...(failureReason ? [`failure: ${failureReason}`] : []),
			"",
		].join("\n"),
		"utf8",
	);
	console.log(`step ${step}: ${status} (${durationMs} ms)`);

	return {
		step,
		name,
		command: displayCommand,
		logPath: outputPath,
		exitCode,
		durationMs,
		status,
		failureReason,
	};
}

function recordSkipped(
	findingsDir: string,
	step: number,
	name: string,
	displayCommand: string,
	reason: string,
): CheckResult {
	const outputPath = logPath(findingsDir, step, name);
	const output = `${reason}\nRun with: npm run release-check -- --live\n`;
	writeFileSync(
		outputPath,
		[
			`command: ${displayCommand}`,
			"exit code: n/a",
			"duration: 0 ms",
			"status: SKIPPED",
			"",
			"output:",
			output,
		].join("\n"),
		"utf8",
	);
	console.log(`step ${step}: SKIPPED (${displayCommand})`);

	return {
		step,
		name,
		command: displayCommand,
		logPath: outputPath,
		exitCode: null,
		durationMs: 0,
		status: "SKIPPED",
	};
}

function discoverTests(): { files: string[]; error?: string } {
	try {
		const entries = readdirSync(join(repoRoot, "tests"), { withFileTypes: true });
		return {
			files: entries
				.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
				.map((entry) => join("tests", entry.name))
				.sort(),
		};
	} catch (error) {
		return {
			files: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function headSha(): string {
	try {
		return (
			execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repoRoot,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim() || "unknown"
		);
	} catch {
		return "unknown";
	}
}

function resultStatus(result: CheckResult): string {
	return result.status;
}

function summaryText(findingsDir: string, results: CheckResult[], tests: string[], head: string): string {
	const overall = results.every((result) => result.status !== "FAIL");
	const modelStatus = live ? "used" : "not run (--live was not supplied)";
	const rows = results.map((result) => {
		const exitCode = result.exitCode === null ? "n/a" : String(result.exitCode);
		const relativeLog = result.logPath.replace(`${findingsDir}/`, "");
		return `| ${result.step} | ${result.name} | ${resultStatus(result)} | ${exitCode} | ${result.durationMs} ms | \`${relativeLog}\` |`;
	});

	return [
		"# Release check",
		"",
		`Overall: **${overall ? "PASS" : "FAIL"}**`,
		"",
		`- Git HEAD: \`${head}\``,
		`- Live mode: ${live ? "enabled" : "skipped"}`,
		`- Test files: ${tests.length === 0 ? "none discovered" : tests.join(", ")}`,
		"",
		"## Model list",
		"",
		`- \`${smokeModels[0]}\` — ${modelStatus}`,
		`- \`${smokeModels[1]}\` — ${modelStatus}`,
		"",
		"## Status",
		"",
		"| Step | Check | Status | Exit code | Duration | Evidence |",
		"| ---: | --- | --- | ---: | ---: | --- |",
		...rows,
		"",
		`Evidence directory: \`${findingsDir}\``,
		"",
	].join("\n");
}

const findingsDir = createFindingsDir();
const results: CheckResult[] = [];

results.push(
	runCommand(findingsDir, 1, "typecheck", "npx", ["tsc", "--noEmit"], "npx tsc --noEmit"),
);

const discovered = discoverTests();
const testArgs = ["--experimental-strip-types", "--test", ...discovered.files];
const testsResult = runCommand(
	findingsDir,
	2,
	"tests",
	process.execPath,
	testArgs,
	`node ${testArgs.map(quoteArgument).join(" ")}`,
);
if (discovered.error || discovered.files.length === 0) {
	testsResult.status = "FAIL";
	testsResult.failureReason = discovered.error ?? "no tests/*.test.ts files were discovered";
	appendFileSync(
		testsResult.logPath,
		`\n\nrelease-check discovery failure: ${testsResult.failureReason}\n`,
		"utf8",
	);
}
results.push(testsResult);

if (live) {
	const smokeScript = join("scripts", "smoke.ts");
	results.push(
		runCommand(
			findingsDir,
			3,
			"live-priced-claude-fable-5",
			process.execPath,
			["--experimental-strip-types", smokeScript, smokeModels[0]],
			`node --experimental-strip-types ${smokeScript} ${smokeModels[0]}`,
		),
	);
	results.push(
		runCommand(
			findingsDir,
			4,
			"live-rate-limit-delay",
			"sleep",
			["75"],
			"sleep 75",
		),
	);
	results.push(
		runCommand(
			findingsDir,
			5,
			"live-zero-priced-deepseek",
			process.execPath,
			["--experimental-strip-types", smokeScript, smokeModels[1]],
			`node --experimental-strip-types ${smokeScript} ${smokeModels[1]}`,
		),
	);
} else {
	console.log(
		`Skipped live checks: ${smokeModels[0]} and ${smokeModels[1]} (scripts/smoke.ts).`,
	);
	console.log("Run them with: npm run release-check -- --live");
	results.push(
		recordSkipped(
			findingsDir,
			3,
			"live-priced-claude-fable-5",
			`node --experimental-strip-types scripts/smoke.ts ${smokeModels[0]}`,
			`Skipped live smoke for ${smokeModels[0]} because --live was not supplied.`,
		),
	);
	results.push(
		recordSkipped(
			findingsDir,
			4,
			"live-zero-priced-deepseek",
			`node --experimental-strip-types scripts/smoke.ts ${smokeModels[1]}`,
			`Skipped live smoke for ${smokeModels[1]} because --live was not supplied.`,
		),
	);
}

const summaryPath = join(findingsDir, "summary.md");
writeFileSync(summaryPath, summaryText(findingsDir, results, discovered.files, headSha()), "utf8");
const failed = results.some((result) => result.status === "FAIL");
console.log(`release check ${failed ? "FAILED" : "passed"}: ${summaryPath}`);
process.exitCode = failed ? 1 : 0;
