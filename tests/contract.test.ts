import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget, DEFAULT_LIMITS, TreeBudget } from "../src/budget.ts";
import { formatEnvelope, isFailure, type RunResult } from "../src/envelope.ts";
import { captureLeaseBaseline, leaseMatch, leaseViolations, observeChanges } from "../src/lease.ts";
import { runAcceptance } from "../src/verify.ts";

// ---------------------------------------------------------------------------
// Acceptance predicate: the harness runs the caller's definition of done.
// ---------------------------------------------------------------------------

test("a passing predicate verifies", async () => {
	const v = await runAcceptance("true", tmpdir());
	assert.equal(v.ok, true);
	assert.equal(v.exitCode, 0);
});

test("a failing predicate reports its exit code and output", async () => {
	const v = await runAcceptance("echo missing-artifact >&2; exit 3", tmpdir());
	assert.equal(v.ok, false);
	assert.equal(v.exitCode, 3);
	assert.match(v.output, /missing-artifact/);
});

test("a hung predicate is killed, not waited on", async () => {
	const v = await runAcceptance("sleep 60", tmpdir(), 300);
	assert.equal(v.ok, false);
	assert.match(v.output, /timed out/);
});

test("predicate runs in the declared cwd", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mini-accept-"));
	writeFileSync(join(dir, "artifact.txt"), "x");
	const v = await runAcceptance("test -f artifact.txt", dir);
	assert.equal(v.ok, true);
});

// ---------------------------------------------------------------------------
// Lease matching: what the child was licensed to touch.
// ---------------------------------------------------------------------------

test("a bare path licenses itself and its subtree, nothing else", () => {
	assert.equal(leaseMatch("src/http", "src/http/retry.ts"), true);
	assert.equal(leaseMatch("src/http", "src/http"), true);
	assert.equal(leaseMatch("src/http", "src/https/evil.ts"), false);
	assert.equal(leaseMatch("src/http", "srcx/http/f.ts"), false);
});

test("glob patterns match within and across segments correctly", () => {
	assert.equal(leaseMatch("src/*.ts", "src/a.ts"), true);
	assert.equal(leaseMatch("src/*.ts", "src/deep/a.ts"), false);
	assert.equal(leaseMatch("src/**/*.ts", "src/deep/er/a.ts"), true);
	assert.equal(leaseMatch("docs/w?.md", "docs/w8.md"), true);
	assert.equal(leaseMatch("docs/w?.md", "docs/w88.md"), false);
});

test("violations are exactly the unlicensed observed paths", () => {
	const observed = ["src/http/retry.ts", "README.md", "src/http/retry.test.ts"];
	assert.deepEqual(leaseViolations(observed, ["src/http/**"]), ["README.md"]);
	// No lease declared = read-only work assumed elsewhere; nothing to violate.
	assert.deepEqual(leaseViolations(observed, []), []);
});

// ---------------------------------------------------------------------------
// Lease observation: harness-computed diff on a real temp git repo.
// ---------------------------------------------------------------------------

function tempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "mini-lease-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
	git("init", "-b", "main", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	writeFileSync(join(dir, "tracked.txt"), "original\n");
	git("add", "-A");
	git("commit", "-qm", "base");
	return dir;
}

test("observation sees a new file and a modified tracked file; claims are irrelevant", async () => {
	const dir = tempRepo();
	const baseline = await captureLeaseBaseline(dir);
	assert.equal(baseline.git, true);

	writeFileSync(join(dir, "tracked.txt"), "changed\n");
	writeFileSync(join(dir, "new.txt"), "hello\n");

	const { observed } = await observeChanges(dir, baseline);
	assert.deepEqual(observed, ["new.txt", "tracked.txt"]);
});

test("a file dirty before the run and untouched by it is NOT attributed to the child", async () => {
	const dir = tempRepo();
	writeFileSync(join(dir, "tracked.txt"), "pre-existing dirt\n");
	const baseline = await captureLeaseBaseline(dir);

	writeFileSync(join(dir, "child.txt"), "the child's actual work\n");

	const { observed } = await observeChanges(dir, baseline);
	assert.deepEqual(observed, ["child.txt"]);
});

test("outside a git repo, observation reports itself impossible instead of guessing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mini-nogit-"));
	const baseline = await captureLeaseBaseline(dir);
	assert.equal(baseline.git, false);
	const changes = await observeChanges(dir, baseline);
	assert.equal(changes.observed, undefined);
	assert.match(changes.unverifiable ?? "", /not a git work tree/);
});

// ---------------------------------------------------------------------------
// The contract in the envelope: submission is not success.
// ---------------------------------------------------------------------------

function result(overrides: Partial<RunResult> = {}): RunResult {
	const b = new Budget(DEFAULT_LIMITS, new TreeBudget(10));
	return {
		exitReason: "submitted",
		summary: "done",
		filesChanged: [],
		filesChangedSource: "none",
		claimedFilesChanged: [],
		budget: b.snapshot(),
		ledgerDir: "/tmp/x",
		steps: 3,
		costUsd: 0.12,
		band: "standard",
		control: {
			journalUpdates: 1,
			verifiedEntries: 1,
			openItems: 0,
			steers: { repeat: 0, inertia: 0, journal: 0 },
			checkpoints: 0,
			submitRejections: 0,
			throttledRetries: 0,
		},
		...overrides,
	};
}

test("a submitted run with a failing predicate is a failure, whatever it claims", () => {
	const r = result({
		summary: "Everything works perfectly.",
		verification: { command: "npm test", exitCode: 1, ok: false, output: "2 failing" },
	});
	assert.equal(isFailure(r), true);
	const envelope = formatEnvelope(r);
	assert.match(envelope, /verified: FAIL/);
	assert.match(envelope, /failed its contract/);
});

test("a submitted run with an out-of-lease write is a failure", () => {
	const r = result({ leaseViolations: ["~/.ssh/config"] });
	assert.equal(isFailure(r), true);
	assert.match(formatEnvelope(r), /lease violations: ~\/\.ssh\/config/);
});

test("a verified, lease-clean submission passes", () => {
	const r = result({
		verification: { command: "test -f out.md", exitCode: 0, ok: true, output: "" },
		filesChanged: ["out.md"],
		filesChangedSource: "observed",
		claimedFilesChanged: ["out.md"],
	});
	assert.equal(isFailure(r), false);
	const envelope = formatEnvelope(r);
	assert.match(envelope, /verified: PASS/);
	assert.match(envelope, /files changed \(observed\): out\.md/);
});

test("phantom claims are named in the envelope", () => {
	const envelope = formatEnvelope(
		result({
			filesChanged: ["real.ts"],
			filesChangedSource: "observed",
			claimedFilesChanged: ["real.ts", "phantom.ts"],
		}),
	);
	assert.match(envelope, /claim mismatch: .*phantom\.ts/);
});

test("unobservable changes are labelled as testimony, not fact", () => {
	const envelope = formatEnvelope(
		result({ filesChanged: ["a.ts"], filesChangedSource: "claimed", claimedFilesChanged: ["a.ts"] }),
	);
	assert.match(envelope, /claimed, unverified/);
});

test("a binding error is a distinct exit reason, never a silent success", () => {
	const r = result({ exitReason: "binding_error", error: "401 Model is disabled" });
	assert.equal(isFailure(r), true);
	assert.match(formatEnvelope(r), /status: binding_error/);
});
