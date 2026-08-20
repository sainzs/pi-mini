/**
 * Context-ceiling recovery: one harder-elision retry instead of death.
 *
 * A deep run with large observations can exceed the model's context window;
 * before this, the run died as a generic "error" even though the journal and
 * the on-disk observations exist precisely so the transcript is reconstructible
 * after aggressive elision. pi's own session answers the first overflow with
 * one compact-and-retry (the overflow branch of `_checkCompaction` in
 * agent-session.js) and settles on the second. The harness side of that
 * contract is pinned here: overflow errors get their own class (never
 * "throttled" — pacing a retry of the same oversized payload would just
 * re-hit the wall), the first hit halves future observation retention, and
 * the second is terminal with an honest exitReason.
 *
 * Provider shapes below are verbatim from pi-ai's per-provider documentation
 * in src/utils/overflow.ts (OVERFLOW_PATTERNS).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget, DEFAULT_LIMITS, TreeBudget } from "../src/budget.ts";
import { formatEnvelope, isFailure, type RunResult } from "../src/envelope.ts";
import { createLedger, recordObservation } from "../src/ledger.ts";
import {
	classifyProviderError,
	CONTEXT_OVERFLOW_RX,
	isTerminalOverflow,
} from "../src/runner.ts";

// ---------------------------------------------------------------------------
// Classification: the ceiling is its own class, never throttle, never binding.
// ---------------------------------------------------------------------------

test("provider overflow shapes classify as context_overflow", () => {
	for (const text of [
		"prompt is too long: 213462 tokens > 200000 maximum", // Anthropic
		"Your input exceeds the context window of this model", // OpenAI
		"Requested token count exceeds the model's maximum context length of 131072 tokens", // OpenAI/LiteLLM
		"Input length (265330) exceeds model's maximum context length (262144).", // OpenAI-compatible
		"This endpoint's maximum context length is 131072 tokens. However, you requested about 265330 tokens", // OpenRouter
		"The input is too long for the requested model", // Bedrock shape
		"400 Bad Request: too many tokens", // generic fallback
	]) {
		assert.equal(CONTEXT_OVERFLOW_RX.test(text), true, text);
		assert.equal(classifyProviderError(text), "context_overflow", text);
	}
});

test("401 and 429 provider errors do NOT class as overflow", () => {
	// Verbatim shapes pinned in throttle.test.ts.
	const auth = '401: {"error":{"code":"Unauthorized","message":"Access token is invalid"}}';
	const azure429 =
		'429: {"code":"RateLimitReached","message":"Rate limit is exceeded. Try again in 20 seconds."}';

	assert.equal(CONTEXT_OVERFLOW_RX.test(auth), false);
	assert.equal(classifyProviderError(auth), "binding", "a dead binding stays a binding error");

	assert.equal(CONTEXT_OVERFLOW_RX.test(azure429), false);
	assert.equal(classifyProviderError(azure429), "throttled", "rate limiting stays retryable-throttle");
});

test("classification ordering: binding > overflow > throttle", () => {
	// An auth failure that happens to mention a context limit is a dead binding,
	// not a ceiling hit — refunding/retrying auth errors spins forever.
	assert.equal(
		classifyProviderError('401: {"error":{"message":"maximum context length exceeded"}}'),
		"binding",
	);
	// A too-large request carrying a 429 shape is the ceiling, not rate limiting:
	// backing off and resending the same payload would re-hit the same wall.
	assert.equal(
		classifyProviderError("429: prompt is too long: 213462 tokens > 200000 maximum"),
		"context_overflow",
	);
	// And a plain 429 with no overflow signature still classes as throttle.
	assert.equal(classifyProviderError("429 Too Many Requests"), "throttled");
});

test("an unrecognized provider error is still fatal, not overflow", () => {
	assert.equal(CONTEXT_OVERFLOW_RX.test("the model exploded in a new and exciting way"), false);
	assert.equal(classifyProviderError("the model exploded in a new and exciting way"), "fatal");
});

// ---------------------------------------------------------------------------
// Ledger: tightening halves retention, for subsequent observations only.
// ---------------------------------------------------------------------------

test("tightenObservationCaps halves retention for subsequent observations only", () => {
	const dir = mkdtempSync(join(tmpdir(), "mini-ceiling-"));
	const ledger = createLedger(dir, "ceil-1");
	assert.deepEqual(ledger.observationCaps, { head: 2_500, tail: 1_500 });

	const raw = `${"A".repeat(3_000)}${"M".repeat(2_000)}${"Z".repeat(3_000)}`;

	const before = recordObservation(ledger, 1, raw);
	assert.ok(before.startsWith("A".repeat(2_500)), "default head keeps 2500 chars");
	assert.ok(!before.startsWith("A".repeat(2_501)));
	assert.ok(before.endsWith("Z".repeat(1_500)), "default tail keeps 1500 chars");
	assert.match(before, /<elided_chars>4000 characters elided\. Full 8000-char output:/);

	ledger.tightenObservationCaps();
	assert.deepEqual(ledger.observationCaps, { head: 1_250, tail: 750 });

	const after = recordObservation(ledger, 2, raw);
	assert.ok(after.startsWith("A".repeat(1_250)), "tightened head is halved");
	assert.ok(!after.startsWith("A".repeat(1_251)), "no extra head chars survive");
	assert.ok(after.endsWith("Z".repeat(750)), "tightened tail is halved");
	assert.match(after, /<elided_chars>6000 characters elided/, "the marker reports the deeper cut");

	// Subsequent-only: the earlier digest is history and is never rewritten.
	assert.ok(before.startsWith("A".repeat(2_500)), "the first digest keeps the original retention");
	assert.ok(after.length < before.length, "the tighter digest is strictly smaller");

	// Both full outputs survive verbatim on disk; the tighter cap costs
	// cache-reads, not evidence.
	assert.deepEqual(readdirSync(join(ledger.dir, "obs")), ["001.txt", "002.txt"]);
	assert.equal(readFileSync(join(ledger.dir, "obs", "002.txt"), "utf-8"), raw);

	// The tightened threshold binds too: what passed through before now elides.
	assert.match(recordObservation(ledger, 3, "Q".repeat(3_000)), /<elided_chars>/);
	assert.equal(recordObservation(ledger, 4, "small"), "small", "small output still passes through");
});

test("repeated tightening bottoms out at a usable floor", () => {
	const dir = mkdtempSync(join(tmpdir(), "mini-ceiling-"));
	const ledger = createLedger(dir, "ceil-floor");
	for (let i = 0; i < 10; i++) ledger.tightenObservationCaps();
	assert.deepEqual(
		ledger.observationCaps,
		{ head: 500, tail: 300 },
		"the floor keeps head+tail meaningful",
	);
	const raw = "X".repeat(10_000);
	const digest = recordObservation(ledger, 1, raw);
	assert.match(digest, /<elided_chars>/);
	assert.ok(digest.length < raw.length, "still elided");
});

// ---------------------------------------------------------------------------
// Terminal mapping: the second overflow stops the run; the first is retried.
// ---------------------------------------------------------------------------

test("the second overflow is terminal; the first earns the retry", () => {
	const overflow = "prompt is too long: 213462 tokens > 200000 maximum";
	assert.equal(isTerminalOverflow(1, overflow), false, "first hit: tighten, re-broadcast, refund, retry");
	assert.equal(isTerminalOverflow(2, overflow), true, "second hit: the compact-and-retry is spent");
	assert.equal(isTerminalOverflow(5, overflow), true, "further hits stay terminal");
});

test("terminal mapping requires the last error to actually be an overflow", () => {
	const azure429 = '429: {"code":"RateLimitReached","message":"..."}';
	assert.equal(isTerminalOverflow(2, azure429), false, "a throttled ending is not an overflow ending");
	assert.equal(isTerminalOverflow(2, undefined), false, "no captured error, no terminal claim");
	assert.equal(
		isTerminalOverflow(2, "the model exploded in a new and exciting way"),
		false,
		"a fatal ending keeps its own class",
	);
});

// ---------------------------------------------------------------------------
// The envelope: a ceiling-killed run is a failure that names the ceiling.
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

test("a context-overflowed run renders as a failure carrying the overflow count", () => {
	const r = result({
		exitReason: "context_overflow",
		error: "prompt is too long: 213462 tokens > 200000 maximum",
		control: { ...baseControl, contextOverflows: 2 },
	});
	assert.equal(isFailure(r), true);
	const envelope = formatEnvelope(r);
	assert.match(envelope, /status: context_overflow/);
	assert.match(envelope, /context overflow 2x \(retention halved\)/, "the one-line control note");
	assert.match(envelope, /treat the result/i, "a ceiling-killed run is partial, not a success");
});

test("a run without overflow prints no overflow note", () => {
	assert.doesNotMatch(formatEnvelope(result()), /context overflow/);
});
