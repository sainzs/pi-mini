import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderQueue } from "../src/queue.ts";

const queueOptions = (overrides: { maxConcurrent?: number; minGapMs?: number; maxWaitMs?: number } = {}) => ({
	defaultConfig: {
		maxConcurrent: overrides.maxConcurrent ?? 1,
		minGapMs: overrides.minGapMs ?? 0,
	},
	rules: [],
	maxWaitMs: overrides.maxWaitMs ?? 100,
});

test("serializes acquisitions at maxConcurrent one", async () => {
	const queue = new ProviderQueue(queueOptions());
	const first = await queue.acquire("provider/model");
	let secondAcquired = false;
	const secondPromise = queue.acquire("provider/model").then((release) => {
		secondAcquired = true;
		return release;
	});

	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(secondAcquired, false);

	first();
	const second = await secondPromise;
	assert.equal(secondAcquired, true);
	second();
});

test("enforces minGap after a release", async () => {
	const minGapMs = 30;
	const queue = new ProviderQueue(queueOptions({ minGapMs }));
	const first = await queue.acquire("provider/model");
	first();

	const startedWaiting = Date.now();
	const second = await queue.acquire("provider/model");
	const waitedMs = Date.now() - startedWaiting;
	assert.ok(waitedMs >= minGapMs - 5, `waited ${waitedMs}ms for a ${minGapMs}ms gap`);
	second();
});

test("a release in finally frees a slot after a thrown run", async () => {
	const queue = new ProviderQueue(queueOptions());
	try {
		const release = await queue.acquire("provider/model");
		try {
			throw new Error("run failed");
		} finally {
			release();
		}
	} catch (error) {
		assert.equal((error as Error).message, "run failed");
	}

	const release = await queue.acquire("provider/model");
	release();
});

test("wait cap proceeds while the configured slot is still active", async () => {
	const queue = new ProviderQueue(queueOptions({ maxWaitMs: 30 }));
	const first = await queue.acquire("provider/model");
	const startedWaiting = Date.now();
	const second = await queue.acquire("provider/model");
	const waitedMs = Date.now() - startedWaiting;

	assert.ok(waitedMs >= 20, `waited only ${waitedMs}ms before bypassing the cap`);
	second();
	first();
});

test("release is idempotent", async () => {
	const queue = new ProviderQueue(queueOptions());
	const first = await queue.acquire("provider/model");
	first();
	first();

	const second = await queue.acquire("provider/model");
	second();
});
