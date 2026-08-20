/**
 * The env-scrub contract, both halves.
 *
 * (a) `scrubEnv` is a pure function: secret-looking names never reach the
 * child, allowlisted toolchain roots always do, odd build flags pass through,
 * and `NODE_OPTIONS` is dropped as the code-injection channel it is.
 *
 * (b) It is actually wired into `createShTool`. pi's bash tool builds the
 * child environment from the full parent environment (`resolveSpawnContext`
 * in `dist/core/tools/bash.js`, verified 2026-08-20), so without the spawn
 * hook a secret set in `process.env` would appear in `env` output. The
 * integration test runs the tool end-to-end: the child must see `PATH=...`
 * but no trace of the marker.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget, TreeBudget } from "../src/budget.ts";
import { scrubEnv } from "../src/envscrub.ts";
import { type RunLedger, createLedger } from "../src/ledger.ts";
import { createShTool } from "../src/tools.ts";

test("scrubEnv drops secrets and NODE_OPTIONS, keeps the allowlist and odd build flags", () => {
	const out = scrubEnv({
		PATH: "/usr/bin",
		HOME: "/home/u",
		CARGO_HOME: "/cargo",
		FAKE_API_KEY: "k1",
		MY_TOKEN: "t2",
		DB_PASSWORD: "p3",
		NODE_OPTIONS: "--import=./pwn.mjs",
		WEIRD_BUILD_FLAG: "-Dfoo",
	});
	assert.equal(out.PATH, "/usr/bin");
	assert.equal(out.HOME, "/home/u");
	assert.equal(out.CARGO_HOME, "/cargo");
	assert.equal(out.FAKE_API_KEY, undefined);
	assert.equal(out.MY_TOKEN, undefined);
	assert.equal(out.DB_PASSWORD, undefined);
	assert.equal(out.NODE_OPTIONS, undefined, "NODE_OPTIONS is a code-injection channel");
	assert.equal(out.WEIRD_BUILD_FLAG, "-Dfoo", "non-secret odd names pass — the denylist is the boundary");
});

test("scrubEnv matches the denylist case-insensitively", () => {
	const out = scrubEnv({
		my_token: "lowercase",
		Private_Key: "lower",
		AUTH_TICKET: "t",
		COOKIE_JAR: "c",
		safe_var: "ok",
	});
	assert.equal(out.my_token, undefined);
	assert.equal(out.Private_Key, undefined);
	assert.equal(out.AUTH_TICKET, undefined);
	assert.equal(out.COOKIE_JAR, undefined);
	assert.equal(out.safe_var, "ok");
});

test("scrubEnv: the denylist is the boundary and it wins over every name, HOMEBREW_* included", () => {
	// HOMEBREW_GITHUB_API_TOKEN is credential-looking and is a real secret
	// (a GitHub-scoped token for the local brew toolchain). The denylist wins
	// outright: no allowlist carve-out rescues it.
	const out = scrubEnv({
		PATH: "/opt/homebrew/bin:/usr/bin",
		HOME: "/Users/u",
		HOMEBREW_GITHUB_API_TOKEN: "ghp_x",
		HOMEBREW_NO_AUTO_UPDATE: "1",
	});
	// PATH and HOME are allowlisted and never match the denylist, so they survive.
	assert.equal(out.PATH, "/opt/homebrew/bin:/usr/bin");
	assert.equal(out.HOME, "/Users/u");
	assert.equal(out.HOMEBREW_GITHUB_API_TOKEN, undefined, "denylist beats the allowlist and HOMEBREW_*");
	assert.equal(out.HOMEBREW_NO_AUTO_UPDATE, "1", "non-secret HOMEBREW_* names still pass");
});

test("scrubEnv returns a fresh object and tolerates undefined values", () => {
	const input: NodeJS.ProcessEnv = { PATH: "/bin", KEEP_ME: undefined };
	const out = scrubEnv(input);
	assert.equal(input.PATH, "/bin", "the input environment must not be mutated");
	assert.notEqual(out, input);
	assert.equal(out.PATH, "/bin");
	assert.ok("KEEP_ME" in out, "present-but-undefined entries are copied as-is");
	assert.equal(out.KEEP_ME, undefined);
});

test("the sh tool's child env is scrubbed end-to-end", async () => {
	const marker = "S3cr3t-L34k-1F9Q7";
	process.env.PI_MINI_TEST_SECRET_TOKEN = marker;
	process.env.NODE_OPTIONS = "--import=./pwn.mjs";
	const ledger: RunLedger = createLedger(mkdtempSync(join(tmpdir(), "mini-envscrub-")), "run-1");
	try {
		const tool = createShTool({
			cwd: process.cwd(),
			budget: new Budget({ steps: 5, usd: 1, wallMs: 60_000 }, new TreeBudget(100)),
			ledger,
		});

		const result = await tool.execute(
			"c1",
			{ command: "env" } as never,
			undefined,
			undefined,
			{} as never,
		);
		const output = fullEnvOutput(result, ledger);

		assert.match(output, /PATH=/);
		assert.ok(!output.includes(marker), "the marker secret value must not reach the child");
		assert.ok(!output.includes("PI_MINI_TEST_SECRET_TOKEN"), "the secret's name must not leak either");
		assert.ok(!output.includes("NODE_OPTIONS"), "NODE_OPTIONS must not reach the child");
	} finally {
		delete process.env.PI_MINI_TEST_SECRET_TOKEN;
		delete process.env.NODE_OPTIONS;
	}
});

/**
 * Pull the full `env` output out of the tool result.
 *
 * The ledger elides oversized observations from context but keeps them whole
 * on disk; the assertions must run against the whole output either way.
 */
function fullEnvOutput(result: { content?: { type: string; text?: string }[] }, ledger: RunLedger): string {
	const text = (result.content ?? [])
		.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
		.join("\n");
	if (!text.includes("characters elided")) return text;
	return readFileSync(join(ledger.dir, "obs", "000.txt"), "utf-8");
}
