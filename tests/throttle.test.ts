/**
 * Throttling must not burn the step budget.
 *
 * Observed failure, 2026-08-20, azure-foundry/DeepSeek-V4-Flash-0731 (eastus2):
 * four consecutive 429 RateLimitReached replies arrived as assistant messages
 * with stopReason "error"; each burned a pre-charged budget step doing zero
 * work (steps 4–7) and the run died as a generic "error". On zero-priced
 * deployments steps are the ONLY binding budget, so throttling silently
 * destroyed it. These tests pin the fix: refund, classification, pacing, and
 * an honest "throttled" exit reason.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Budget, DEFAULT_LIMITS, TreeBudget } from "../src/budget.ts";
import { formatEnvelope, isFailure, type RunResult } from "../src/envelope.ts";
import { backoffDelayMs, classifyProviderError, RETRYABLE_RX } from "../src/runner.ts";

const limits = { steps: 5, usd: 1, wallMs: 60_000 };

function budget(overrides: Partial<typeof limits> = {}, ceiling = 100) {
	return new Budget({ ...limits, ...overrides }, new TreeBudget(ceiling));
}

// ---------------------------------------------------------------------------
// Refund: a throttled request did no work, so it must not keep its step.
// ---------------------------------------------------------------------------

test("refundStep hands a pre-charged step back, floored at zero", () => {
	const b = budget();
	b.refundStep();
	assert.equal(b.steps, 0, "a refund with nothing charged must not go negative");
	b.countStep();
	b.countStep();
	b.refundStep();
	assert.equal(b.steps, 1);
	b.refundStep();
	b.refundStep();
	assert.equal(b.steps, 0, "the floor holds under repeated refunds");
});

test("refundStep never touches USD or the shared tree ceiling", () => {
	const tree = new TreeBudget(100);
	const b = new Budget(limits, tree);
	b.countStep();
	b.charge(0.25);
	b.refundStep();
	assert.equal(b.steps, 0);
	assert.equal(b.usd, 0.25, "observed spend stays charged");
	assert.equal(tree.spentUsd, 0.25, "the tree keeps its share of observed spend");
});

// ---------------------------------------------------------------------------
// Classification: what is retryable and what must stay fatal.
// ---------------------------------------------------------------------------

test("the real Azure 429 text classifies as throttled", () => {
	// Verbatim shape of the observed failure (2026-08-20, eastus2).
	const azure429 =
		'429: {"code":"RateLimitReached","message":"Rate limit is exceeded. Try again in 20 seconds."}';
	assert.equal(RETRYABLE_RX.test(azure429), true);
	assert.equal(classifyProviderError(azure429), "throttled");
});

test("transient 5xx, overload and transport resets classify as throttled", () => {
	for (const text of [
		"503 Service Unavailable",
		"502 Bad Gateway",
		"the server is overloaded, try again later",
		"read ECONNRESET",
		"connect ETIMEDOUT 20.1.2.3:443",
		"socket hang up",
		"Rate limit reached for requests",
	]) {
		assert.equal(classifyProviderError(text), "throttled", text);
	}
});

test("auth failures never classify as throttled — they stay binding errors", () => {
	// Refunding steps for a dead binding would let the session's auto-continue
	// loop spin forever without spending anything, so these must not match.
	for (const text of [
		'401: {"error":{"code":"Unauthorized","message":"Access token is invalid"}}',
		"403 Forbidden",
		"Model is disabled for this subscription",
	]) {
		assert.equal(RETRYABLE_RX.test(text), false, text);
		assert.equal(classifyProviderError(text), "binding", text);
	}
});

test("an unrecognized provider error is fatal, not retryable", () => {
	assert.equal(classifyProviderError("the model exploded in a new and exciting way"), "fatal");
});

// ---------------------------------------------------------------------------
// Pacing: exponential backoff with jitter, capped so the wall clock can bind.
// ---------------------------------------------------------------------------

test("backoff doubles per attempt and caps at 30 seconds", () => {
	assert.equal(backoffDelayMs(0, 0), 1_000);
	assert.equal(backoffDelayMs(1, 0), 2_000);
	assert.equal(backoffDelayMs(2, 0), 4_000);
	assert.equal(backoffDelayMs(0, 500), 1_500);
	assert.equal(backoffDelayMs(5, 0), 30_000, "2^5 s overshoots; the cap must bind");
	assert.equal(backoffDelayMs(20, 500), 30_000);
});

test("default jitter stays within the advertised envelope", () => {
	for (let i = 0; i < 20; i++) {
		const delay = backoffDelayMs(0);
		assert.ok(delay >= 1_000 && delay <= 1_500, `attempt-0 delay ${delay} outside [1000, 1500]`);
	}
});

// ---------------------------------------------------------------------------
// The envelope: a throttled run is a failure that reports its retry count.
// ---------------------------------------------------------------------------

const baseControl: RunResult["control"] = {
	journalUpdates: 1,
	verifiedEntries: 1,
	openItems: 0,
	steers: { repeat: 0, inertia: 0, journal: 0 },
	checkpoints: 0,
	submitRejections: 0,
	throttledRetries: 0,
};

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
		costUsd: 0,
		band: "standard",
		control: { ...baseControl },
		...overrides,
	};
}

test("a throttled run renders as a failure carrying its retry count", () => {
	const r = result({
		exitReason: "throttled",
		error: '429: {"code":"RateLimitReached","message":"..."}',
		control: { ...baseControl, throttledRetries: 4 },
	});
	assert.equal(isFailure(r), true);
	const envelope = formatEnvelope(r);
	assert.match(envelope, /status: throttled/);
	assert.match(envelope, /throttled 4x/, "the control line must print the attempts count");
	assert.match(envelope, /treat the result/i, "a throttled run is partial, not a success");
});

test("an unthrottled run does not print a throttle line", () => {
	assert.doesNotMatch(formatEnvelope(result()), /throttled/);
});
