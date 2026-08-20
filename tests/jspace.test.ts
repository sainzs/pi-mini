/**
 * Tests for the J-Space control plane: journal, supervisor, submit gate,
 * checkpoints. Origin of the semantics: J-Space Cognition Suite V3.6 (CC
 * BY-ND 4.0, Tiger3807861189) — ledger, bridge-before-conclusion, verifier
 * coverage, seam refresh, differential checkpoints, discrete routing bands.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointRecorder } from "../src/checkpoints.ts";
import {
	createJournalState,
	createJournalTool,
	journalDigest,
	renderJournal,
} from "../src/journal.ts";
import { BANDS, Supervisor } from "../src/supervisor.ts";
import { createSubmitTool, type SubmitDetails } from "../src/tools.ts";

// ---------------------------------------------------------------------------
// Journal — the externalized ledger.
// ---------------------------------------------------------------------------

test("journal write replaces full state and persists journal.md", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mini-journal-"));
	const state = createJournalState();
	const tool = createJournalTool({ state, dir, currentStep: () => 7 });

	await tool.execute("c1", {
		goal: "make the retry test deterministic",
		core: ["keep the public API", "no new deps"],
		verified: ["flaky case reproduced: `npm test -- retry` fails 3/10 pre-fix"],
		open: ["whether CI uses a different clock"],
		next: "seed the RNG in src/http/retry.ts:91",
	}, undefined, undefined, {} as never);

	assert.equal(state.updates, 1);
	assert.equal(state.lastJournalStep, 7);
	const rendered = readFileSync(join(dir, "journal.md"), "utf-8");
	assert.match(rendered, /# Goal/);
	assert.match(rendered, /keep the public API/);
	assert.match(rendered, /seed the RNG/);
	assert.equal(rendered, renderJournal(state));
});

test("journal caps are enforced by code, and items are single-lined", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mini-journal-cap-"));
	const state = createJournalState();
	const tool = createJournalTool({ state, dir, currentStep: () => 1 });

	await tool.execute("c1", {
		verified: Array.from({ length: 40 }, (_, i) => `claim ${i}\nwith a newline ${"x".repeat(300)}`),
		next: `multi\nline ${"y".repeat(400)}`,
	}, undefined, undefined, {} as never);

	assert.equal(state.verified.length, 12, "verified list is capped at 12");
	for (const item of state.verified) {
		assert.ok(item.length <= 201, `item too long: ${item.length}`);
		assert.ok(!item.includes("\n"), "items must be single-line");
	}
	assert.ok(!state.next?.includes("\n"));
});

test("journalDigest is a bounded broadcast of settled constraints", () => {
	const state = createJournalState();
	state.goal = "g";
	state.core = ["c1", "c2"];
	state.verified = ["v1", "v2"];
	state.open = ["o1"];
	state.next = "n";
	const digest = journalDigest(state);
	assert.match(digest, /goal: g/);
	assert.match(digest, /core: c1 · c2/);
	assert.match(digest, /verified: 2 item\(s\)/);
	assert.ok(digest.length < 800);
});

// ---------------------------------------------------------------------------
// Supervisor — stall detection and steering.
// ---------------------------------------------------------------------------

test("repeat nudge fires at the threshold and respects its cooldown", () => {
	const sup = new Supervisor({ expectsWrite: false, tuning: BANDS.standard });
	assert.equal(sup.noteCommand("cat   src/a.ts"), false);
	assert.equal(sup.nudge(1, 1), undefined);
	sup.noteCommand("cat src/a.ts"); // same normalized command: 1st repeat
	assert.equal(sup.nudge(2, 2), undefined, "one repeat is not yet a loop");
	sup.noteCommand("cat src/a.ts"); // 2nd repeat → threshold
	const nudge = sup.nudge(3, 3);
	assert.ok(nudge, "third identical command should nudge");
	assert.equal(nudge.kind, "repeat");
	assert.match(nudge.text, /\[supervisor\]/);
	// Cooldown: cannot re-fire immediately even if the loop continues.
	sup.noteCommand("cat src/a.ts");
	assert.equal(sup.nudge(4, 4), undefined);
	assert.equal(sup.counts.repeat, 1);
});

test("inertia nudge fires only on write tasks, after the window", () => {
	// Fresh journals passed throughout, so the journal nudge cannot mask inertia.
	const readOnlyRun = new Supervisor({ expectsWrite: false, tuning: BANDS.standard });
	for (let i = 0; i < 10; i++) readOnlyRun.noteCommand(`rg pattern${i} src/`);
	assert.equal(readOnlyRun.nudge(10, 10), undefined, "read-only task: no inertia nudge");

	const writeRun = new Supervisor({ expectsWrite: true, tuning: BANDS.standard });
	for (let i = 0; i < 7; i++) writeRun.noteCommand(`rg pattern${i} src/`);
	const nudge = writeRun.nudge(8, 8);
	assert.equal(nudge?.kind, "inertia");
	assert.match(nudge.text ?? "", /candidate next actions/);

	// A write-ish command resets the window.
	writeRun.noteCommand("sed -i '' 's/a/b/' src/x.ts");
	for (let i = 0; i < 4; i++) writeRun.noteCommand(`cat src/f${i}.ts`);
	assert.equal(writeRun.nudge(14, 14), undefined, "window reset by a write");
});

test("stale-journal nudge re-broadcasts after the cadence window", () => {
	const sup = new Supervisor({ expectsWrite: false, tuning: BANDS.standard });
	sup.noteCommand("rg a src/");
	const nudge = sup.nudge(10, 1); // 9 steps since the last journal write
	assert.equal(nudge?.kind, "journal");
	assert.match(nudge.text ?? "", /goal \/ core \/ verified \/ open \/ next/);
	// Fresh journal → no nudge.
	assert.equal(sup.nudge(11, 10), undefined);
});

test("writeish detection covers redirection and common mutators", () => {
	const sup = new Supervisor({ expectsWrite: true, tuning: BANDS.quick });
	assert.equal(sup.noteCommand("cat > out.txt <<'EOF'\nhi\nEOF"), true);
	assert.equal(sup.noteCommand("git apply fix.patch"), true);
	assert.equal(sup.noteCommand("npm install lodash"), true);
	assert.equal(sup.noteCommand("rg foo src/ && cat a.ts"), false);
});

// ---------------------------------------------------------------------------
// Submit gate — bridge-before-conclusion as a tool-level contract.
// ---------------------------------------------------------------------------

test("a failed gate rejects the submit without terminating the run", async () => {
	let submitted: SubmitDetails | undefined;
	let rejections = 0;
	const tool = createSubmitTool(
		(d) => {
			submitted = d;
		},
		() => ({ ok: false as const, reason: "no journal `verified` entries" }),
		() => {
			rejections++;
		},
	);

	const result = await tool.execute("c1", { summary: "trust me", filesChanged: [] }, undefined, undefined, {} as never);
	assert.equal((result as { isError?: boolean }).isError, true);
	assert.equal(rejections, 1);
	assert.equal(submitted, undefined, "rejected submit must not record a result");
	assert.match((result.content[0] as { text: string }).text, /SUBMIT REJECTED/);
	assert.ok(!("terminate" in result && result.terminate), "rejection must not terminate");
});

test("a passing gate submits and terminates exactly once", async () => {
	let submitted: SubmitDetails | undefined;
	const tool = createSubmitTool(
		(d) => {
			submitted = d;
		},
		() => ({ ok: true as const }),
	);
	const result = await tool.execute("c1", { summary: "done, evidence in journal", filesChanged: ["a.ts"] }, undefined, undefined, {} as never);
	assert.equal(submitted?.summary, "done, evidence in journal");
	assert.equal((result as { terminate?: boolean }).terminate, true);
});

test("no gate at all preserves the v0.2 submit behavior", async () => {
	let submitted: SubmitDetails | undefined;
	const tool = createSubmitTool((d) => {
		submitted = d;
	});
	const result = await tool.execute("c1", { summary: "s" }, undefined, undefined, {} as never);
	assert.equal(submitted?.summary, "s");
	assert.equal((result as { terminate?: boolean }).terminate, true);
});

// ---------------------------------------------------------------------------
// Checkpoints — differential recovery points in git.
// ---------------------------------------------------------------------------

function gitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "mini-ckpt-"));
	const g = (args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
	g(["init", "-q"]);
	g(["config", "user.email", "t@t"]);
	g(["config", "user.name", "t"]);
	writeFileSync(join(dir, "a.txt"), "one\n");
	g(["add", "."]);
	g(["commit", "-qm", "init"]);
	return dir;
}

test("checkpoint fires on observed change and stays silent on a clean tree", async () => {
	const dir = gitRepo();
	const runDir = mkdtempSync(join(tmpdir(), "mini-ckpt-run-"));
	const rec = new CheckpointRecorder(dir, runDir, dir);

	await rec.maybeSnapshot(1);
	assert.equal(rec.count, 0, "clean tree: no checkpoint");

	writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
	await rec.maybeSnapshot(2);
	assert.equal(rec.count, 1, "dirty tree: checkpoint taken");
	const patch = readFileSync(join(runDir, "checkpoints", "000.patch"), "utf-8");
	assert.match(patch, /\+two/);

	// Same tree state → no duplicate snapshot.
	await rec.maybeSnapshot(3);
	assert.equal(rec.count, 1);

	// Rollback applicability is the whole point: the patch reverses cleanly.
	execFileSync("git", ["apply", "-R", join(runDir, "checkpoints", "000.patch")], { cwd: dir });
	assert.equal(readFileSync(join(dir, "a.txt"), "utf-8"), "one\n");
});

test("untracked files are indexed but honestly excluded from the patch", async () => {
	const dir = gitRepo();
	const runDir = mkdtempSync(join(tmpdir(), "mini-ckpt-run-"));
	const rec = new CheckpointRecorder(dir, runDir, dir);

	writeFileSync(join(dir, "new.txt"), "brand new\n");
	await rec.maybeSnapshot(1);
	assert.equal(rec.count, 1);
	const index = readFileSync(join(runDir, "checkpoints", "index.ndjson"), "utf-8");
	assert.match(index, /untrackedNotPatched/);
	assert.match(index, /new\.txt/);
});

test("a non-git cwd makes the recorder inert", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mini-ckpt-nogit-"));
	const rec = new CheckpointRecorder(dir, dir, undefined);
	assert.equal(rec.active, false);
	await rec.maybeSnapshot(1);
	assert.equal(rec.count, 0);
	assert.ok(!existsSync(join(dir, "checkpoints")));
});

// ---------------------------------------------------------------------------
// Model routing — the default is DeepSeek-V4-Flash-0731; overrides resolve.
// ---------------------------------------------------------------------------

import { resolveSummonModel } from "../src/index.ts";

function fakeRegistry(ids: Array<[string, string]>, authed = true) {
	const models = ids.map(([provider, id]) => ({ provider, id }));
	return {
		find: (provider: string, modelId: string) =>
			models.find((m) => m.provider === provider && m.id === modelId),
		getAvailable: () => models,
		hasConfiguredAuth: () => authed,
	};
}

const REG = fakeRegistry([
	["azure-foundry", "DeepSeek-V4-Flash-0731"],
	["azure-foundry", "gpt-5.6-sol"],
	["azure-foundry-claude", "claude-opus-5"],
]);

test("no spec resolves to the DeepSeek-V4-Flash-0731 default", () => {
	delete process.env.PI_MINI_MODEL;
	const r = resolveSummonModel(undefined, REG, { id: "claude-fable-5" });
	assert.equal(r.id, "DeepSeek-V4-Flash-0731");
	assert.equal(r.source, "default");
});

test("an explicit provider/id param wins over the default", () => {
	const r = resolveSummonModel("azure-foundry-claude/claude-opus-5", REG, undefined);
	assert.equal(r.id, "claude-opus-5");
	assert.equal(r.source, "param");
});

test("bare ids resolve case-insensitively and by substring", () => {
	assert.equal(resolveSummonModel("deepseek-v4-flash-0731", REG, undefined).id, "DeepSeek-V4-Flash-0731");
	assert.equal(resolveSummonModel("opus-5", REG, undefined).id, "claude-opus-5");
});

test("PI_MINI_MODEL overrides the default but loses to an explicit param", () => {
	process.env.PI_MINI_MODEL = "azure-foundry/gpt-5.6-sol";
	try {
		assert.equal(resolveSummonModel(undefined, REG, undefined).source, "env");
		assert.equal(resolveSummonModel(undefined, REG, undefined).id, "gpt-5.6-sol");
		assert.equal(resolveSummonModel("claude-opus-5", REG, undefined).source, "param");
	} finally {
		delete process.env.PI_MINI_MODEL;
	}
});

test("unresolvable or unauthenticated specs inherit, labelled as fallback", () => {
	const bad = resolveSummonModel("azure-foundry/No-Such-Model", REG, { id: "claude-fable-5" });
	assert.equal(bad.id, "claude-fable-5");
	assert.equal(bad.source, "inherited-fallback");

	const noauth = fakeRegistry([["azure-foundry", "DeepSeek-V4-Flash-0731"]], false);
	assert.equal(resolveSummonModel(undefined, noauth, { id: "x" }).source, "inherited-fallback");
});
