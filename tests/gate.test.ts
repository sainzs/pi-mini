/**
 * Submit-gate ground truth: the harness executes `accept` at submit time.
 *
 * Containment-matching the child's `sh` text against the accept string was
 * gameable (`echo 'npm test'` exits 0 and contains the string). These tests
 * lock the replacement: only an exit 0 the gate itself observed can pass, and
 * past `maxAcceptRuns` it must refuse to spawn another process.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSubmitGate } from "../src/gate.ts";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "mini-gate-"));
}

test("rejects when there are no verified journal entries", async () => {
	const { gate, state } = createSubmitGate({
		hasVerified: () => false,
		cwd: tmp(),
		maxRejections: 5,
	});
	const verdict = await gate();
	assert.equal(verdict.ok, false);
	assert.match((verdict as { reason: string }).reason, /no journal `verified` entries/);
	assert.equal(state.rejections, 1);
	assert.equal(state.gateOverridden, false);
	assert.equal(state.acceptObservedPass, false);
	assert.equal(state.acceptRuns, 0, "must not spend an accept run before a bridge exists");
});

test("passes with verified entries and no accept command", async () => {
	const { gate, state } = createSubmitGate({
		hasVerified: () => true,
		cwd: tmp(),
		maxRejections: 5,
	});
	const verdict = await gate();
	assert.deepEqual(verdict, { ok: true });
	assert.equal(state.rejections, 0);
	assert.equal(state.gateOverridden, false);
	assert.equal(state.acceptObservedPass, false);
	assert.equal(state.acceptRuns, 0);
});

test("accept declared: the gate executes it against the cwd", async () => {
	const dir = tmp();
	const { gate, state } = createSubmitGate({
		hasVerified: () => true,
		accept: "test -f flag.txt",
		cwd: dir,
		maxRejections: 5,
	});

	const missing = await gate();
	assert.equal(missing.ok, false);
	assert.match((missing as { reason: string }).reason, /test -f flag\.txt/);
	assert.equal(state.acceptRuns, 1);
	assert.equal(state.acceptObservedPass, false);

	writeFileSync(join(dir, "flag.txt"), "ok\n");
	const present = await gate();
	assert.deepEqual(present, { ok: true });
	assert.equal(state.acceptRuns, 2);
	assert.equal(state.acceptObservedPass, true);
	assert.equal(state.rejections, 1);
});

test("gaming: nothing except the gate's own execution can satisfy accept", async () => {
	const dir = tmp();
	const { gate, state } = createSubmitGate({
		hasVerified: () => true,
		accept: "test -f flag.txt",
		cwd: dir,
		maxRejections: 5,
		maxAcceptRuns: 5,
	});

	// The old containment matcher treated `echo 'test -f flag.txt'` as a pass.
	// The gate runs the real command; a file that merely mentions it must not help.
	writeFileSync(join(dir, "spoof.sh"), "echo 'test -f flag.txt'\n");
	const spoofed = await gate();
	assert.equal(spoofed.ok, false);
	assert.equal(state.acceptObservedPass, false);

	assert.throws(
		() => {
			(state as { acceptObservedPass: boolean }).acceptObservedPass = true;
		},
		TypeError,
		"state is observational — there is no setter to fake a pass",
	);
	assert.equal(state.acceptObservedPass, false);

	writeFileSync(join(dir, "flag.txt"), "");
	const real = await gate();
	assert.deepEqual(real, { ok: true });
	assert.equal(state.acceptObservedPass, true);
});

test("after maxRejections the gate yields ok:true and labels gateOverridden", async () => {
	const { gate, state } = createSubmitGate({
		hasVerified: () => false,
		cwd: tmp(),
		maxRejections: 2,
	});

	assert.equal((await gate()).ok, false);
	assert.equal((await gate()).ok, false);
	assert.equal(state.rejections, 2);
	assert.equal(state.gateOverridden, false);

	const yielded = await gate();
	assert.deepEqual(yielded, { ok: true });
	assert.equal(state.gateOverridden, true);
	assert.equal(state.rejections, 2, "yielding must not count as another rejection");
});

test("execution cap: a 3rd failing submit does not spawn a 3rd process", async () => {
	const dir = tmp();
	const counter = join(dir, "counter.txt");
	const { gate, state } = createSubmitGate({
		hasVerified: () => true,
		accept: "echo ran >> counter.txt; echo FAIL-OUTPUT; exit 7",
		cwd: dir,
		maxRejections: 10,
		// default maxAcceptRuns is 2
	});

	const first = await gate();
	assert.equal(first.ok, false);
	assert.match((first as { reason: string }).reason, /FAIL-OUTPUT/);
	assert.match((first as { reason: string }).reason, /exited 7/);

	const second = await gate();
	assert.equal(second.ok, false);

	assert.equal(readFileSync(counter, "utf-8").trim().split("\n").length, 2);
	assert.equal(state.acceptRuns, 2);

	const third = await gate();
	assert.equal(third.ok, false);
	assert.match((third as { reason: string }).reason, /accept execution budget exhausted/);
	assert.equal(state.acceptRuns, 2, "budget reject must not increment acceptRuns");
	assert.equal(
		readFileSync(counter, "utf-8").trim().split("\n").length,
		2,
		"the 3rd submit must not spawn another accept process",
	);
	assert.equal(state.gateOverridden, false);
	assert.equal(state.rejections, 3);
});

test("accept exec is async, nonblocking, and runs in a scrubbed env", async () => {
	process.env.PI_GATE_ACCEPT_SECRET = "S3cr3t-Accept-9Q";
	const dir = tmp();
	const { gate, state } = createSubmitGate({
		hasVerified: () => true,
		// Exits 0 only when the secret is absent from the child env — proof the
		// accept exec gets scrubEnv(process.env), not the raw parent env.
		accept: "test -z \"$PI_GATE_ACCEPT_SECRET\"",
		cwd: dir,
		maxRejections: 5,
	});
	try {
		// Fire both without awaiting the first: the gate must not hold the event
		// loop while one accept is in flight. Each invocation runs and passes on
		// its own observed exit 0.
		const [a, b] = await Promise.all([gate(), gate()]);
		assert.deepEqual(a, { ok: true });
		assert.deepEqual(b, { ok: true });
		assert.equal(state.acceptRuns, 2);
		assert.equal(state.acceptObservedPass, true);
	} finally {
		delete process.env.PI_GATE_ACCEPT_SECRET;
	}
});
