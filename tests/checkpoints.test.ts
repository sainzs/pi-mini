/**
 * Checkpoint rollback completeness: new files must be IN the patch.
 *
 * The recorder used to index untracked files but honestly exclude them from
 * the patch, so `git apply -R` restored edits while leaving brand-new files
 * behind — a mixed state. Intent-to-add closes the gap: the diff now covers
 * new files, reverse-apply removes them, and the post-diff reset leaves the
 * working tree's untracked status exactly as it was.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CheckpointRecorder } from "../src/checkpoints.ts";

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

function porcelain(dir: string): string {
	return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf-8" });
}

test("a brand-new file lands in the patch and reverse-apply removes it", async () => {
	const dir = gitRepo();
	const runDir = mkdtempSync(join(tmpdir(), "mini-ckpt-run-"));
	const rec = new CheckpointRecorder(dir, runDir, dir);

	writeFileSync(join(dir, "new.txt"), "brand new\n");
	await rec.maybeSnapshot(1);
	assert.equal(rec.count, 1);
	const patch = readFileSync(join(runDir, "checkpoints", "000.patch"), "utf-8");
	assert.match(patch, /new file mode/);
	assert.match(patch, /\+brand new/);

	execFileSync("git", ["apply", "-R", join(runDir, "checkpoints", "000.patch")], { cwd: dir });
	assert.ok(!existsSync(join(dir, "new.txt")), "reverse apply must remove the new file");
});

test("after the snapshot the new file is still untracked", async () => {
	const dir = gitRepo();
	const runDir = mkdtempSync(join(tmpdir(), "mini-ckpt-run-"));
	const rec = new CheckpointRecorder(dir, runDir, dir);

	writeFileSync(join(dir, "new.txt"), "brand new\n");
	await rec.maybeSnapshot(1);
	assert.equal(rec.count, 1);
	assert.equal(porcelain(dir), "?? new.txt\n", "the intent-to-add must be undone by the reset");
});

test("a mixed edit-plus-new-file change reverses cleanly to the original state", async () => {
	const dir = gitRepo();
	const runDir = mkdtempSync(join(tmpdir(), "mini-ckpt-run-"));
	const rec = new CheckpointRecorder(dir, runDir, dir);

	writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
	writeFileSync(join(dir, "new.txt"), "brand new\n");
	await rec.maybeSnapshot(1);
	assert.equal(rec.count, 1);

	const patch = readFileSync(join(runDir, "checkpoints", "000.patch"), "utf-8");
	assert.match(patch, /\+two/, "the edit is in the patch");
	assert.match(patch, /new file mode/, "the new file is in the patch");

	execFileSync("git", ["apply", "-R", join(runDir, "checkpoints", "000.patch")], { cwd: dir });
	assert.equal(readFileSync(join(dir, "a.txt"), "utf-8"), "one\n");
	assert.ok(!existsSync(join(dir, "new.txt")), "rollback removes the new file");
	assert.equal(porcelain(dir), "", "the tree is back to the committed state");
});

test("a non-git cwd stays inert", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mini-ckpt-nogit-"));
	const rec = new CheckpointRecorder(dir, dir, undefined);
	assert.equal(rec.active, false);
	await rec.maybeSnapshot(1);
	assert.equal(rec.count, 0);
	assert.ok(!existsSync(join(dir, "checkpoints")));
});
