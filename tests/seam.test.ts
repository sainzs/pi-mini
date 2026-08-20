/**
 * Harness-enforced journal seam recovery.
 *
 * The stale-journal *nudge* still asks the model to rewrite its ledger. Settled
 * constraints must re-broadcast themselves when context decays — cadenced digest
 * on the `sh` tail, and one full render after the first elision. Drift-resistance
 * is code, not cooperation.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Budget, TreeBudget } from "../src/budget.ts";
import {
	createJournalState,
	JOURNAL_REBROADCAST_CAP,
	JournalSeam,
	journalDigest,
	renderJournal,
	type JournalState,
} from "../src/journal.ts";
import { createLedger } from "../src/ledger.ts";
import { BANDS, Supervisor } from "../src/supervisor.ts";
import { createShTool } from "../src/tools.ts";

function populated(overrides: Partial<JournalState> = {}): JournalState {
	const state = createJournalState();
	state.goal = "make the retry test deterministic";
	state.core = ["keep the public API"];
	state.verified = ["flaky case reproduced: npm test -- retry fails 3/10"];
	state.open = ["whether CI uses a different clock"];
	state.next = "seed the RNG in src/http/retry.ts:91";
	return Object.assign(state, overrides);
}

function texts(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
}

function budget(): Budget {
	return new Budget({ steps: 40, usd: 1000, wallMs: 60 * 60 * 1000 }, new TreeBudget(100));
}

// ---------------------------------------------------------------------------
// Cadenced digest.
// ---------------------------------------------------------------------------

test("digest cadence fires at the band interval and not off-interval", () => {
	assert.equal(BANDS.quick.digestEvery, 4);
	assert.equal(BANDS.standard.digestEvery, 6);
	assert.equal(BANDS.deep.digestEvery, 8);

	const state = populated();
	const seam = new JournalSeam();
	const every = BANDS.standard.digestEvery;

	for (let step = 1; step < every; step++) {
		assert.equal(
			seam.tail({ state, step, digestEvery: every, journalNudge: false, elidedThisStep: false }),
			undefined,
			`step ${step} is off-interval`,
		);
	}

	const hit = seam.tail({
		state,
		step: every,
		digestEvery: every,
		journalNudge: false,
		elidedThisStep: false,
	});
	assert.ok(hit, "cadence step must emit the digest");
	assert.equal(hit, `[journal] ${journalDigest(state)}`);
	assert.equal(hit.split("\n").length, 1, "digest is a single line");
	assert.match(hit, /^\[journal\] /);

	assert.equal(
		seam.tail({
			state,
			step: every + 1,
			digestEvery: every,
			journalNudge: false,
			elidedThisStep: false,
		}),
		undefined,
		"the step after a hit is off-interval",
	);

	const nextHit = seam.tail({
		state,
		step: every * 2,
		digestEvery: every,
		journalNudge: false,
		elidedThisStep: false,
	});
	assert.equal(nextHit, `[journal] ${journalDigest(state)}`);
});

test("digest is suppressed when a journal nudge fires the same step", () => {
	const state = populated();
	const seam = new JournalSeam();
	const every = BANDS.standard.digestEvery;

	assert.equal(
		seam.tail({
			state,
			step: every,
			digestEvery: every,
			journalNudge: true,
			elidedThisStep: false,
		}),
		undefined,
		"digest is redundant with a journal nudge",
	);

	const later = seam.tail({
		state,
		step: every * 2,
		digestEvery: every,
		journalNudge: false,
		elidedThisStep: false,
	});
	assert.ok(later, "suppression is per-result, not permanent");
	assert.match(later, /^\[journal\] /);
});

test("empty journal emits no digest", () => {
	const state = createJournalState();
	const seam = new JournalSeam();
	assert.equal(
		seam.tail({
			state,
			step: BANDS.quick.digestEvery,
			digestEvery: BANDS.quick.digestEvery,
			journalNudge: false,
			elidedThisStep: false,
		}),
		undefined,
	);
});

// ---------------------------------------------------------------------------
// Elision → one-shot full re-broadcast.
// ---------------------------------------------------------------------------

test("first elision re-broadcasts the full journal on the next result, once, capped", () => {
	const state = populated({
		goal: "G".repeat(500),
		core: Array.from({ length: 8 }, () => "C".repeat(200)),
		verified: Array.from({ length: 12 }, () => "V".repeat(200)),
		open: Array.from({ length: 8 }, () => "O".repeat(200)),
		next: "N".repeat(200),
	});
	assert.ok(renderJournal(state).length > JOURNAL_REBROADCAST_CAP);

	const seam = new JournalSeam();
	const every = BANDS.deep.digestEvery; // 8 — keep cadence off these early steps

	const onElision = seam.tail({
		state,
		step: 1,
		digestEvery: every,
		journalNudge: false,
		elidedThisStep: true,
	});
	assert.equal(onElision, undefined, "the elision result itself is not the re-broadcast");

	const next = seam.tail({
		state,
		step: 2,
		digestEvery: every,
		journalNudge: false,
		elidedThisStep: false,
	});
	assert.ok(next, "the next sh result must carry the full journal");
	assert.match(next, /^\[journal — re-broadcast after elision\]\n/);
	const body = next.slice("[journal — re-broadcast after elision]\n".length);
	assert.equal(body.length, JOURNAL_REBROADCAST_CAP, "body is capped at 1500");
	assert.equal(body, renderJournal(state).slice(0, JOURNAL_REBROADCAST_CAP));

	const laterElision = seam.tail({
		state,
		step: 3,
		digestEvery: every,
		journalNudge: false,
		elidedThisStep: true,
	});
	assert.ok(!laterElision?.includes("re-broadcast after elision"), "no second re-broadcast on a later elision");

	const afterLater = seam.tail({
		state,
		step: 4,
		digestEvery: every,
		journalNudge: false,
		elidedThisStep: false,
	});
	assert.ok(!afterLater?.includes("re-broadcast after elision"), "one-shot is spent for the run");
});

test("elision with an empty journal emits nothing on the next result either", () => {
	const seam = new JournalSeam();
	const empty = createJournalState();
	assert.equal(
		seam.tail({
			state: empty,
			step: 1,
			digestEvery: 4,
			journalNudge: false,
			elidedThisStep: true,
		}),
		undefined,
	);
	assert.equal(
		seam.tail({
			state: empty,
			step: 2,
			digestEvery: 4,
			journalNudge: false,
			elidedThisStep: false,
		}),
		undefined,
	);
});

// ---------------------------------------------------------------------------
// Wired through `sh`: the ledger's elision marker is the decay observation.
// ---------------------------------------------------------------------------

test("sh wires the first elision into exactly one journal re-broadcast on the next result", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mini-seam-"));
	const ledger = createLedger(dir, "seam-1");
	const b = budget();
	const state = populated();
	const seam = new JournalSeam();
	const supervisor = new Supervisor({ expectsWrite: false, tuning: BANDS.standard });
	const tool = createShTool({
		cwd: process.cwd(),
		budget: b,
		ledger,
		supervisor,
		lastJournalStep: () => b.steps,
		journal: state,
		seam,
	});

	b.countStep();
	const elided = await tool.execute(
		"c1",
		{ command: "node -e \"process.stdout.write('X'.repeat(8000))\"" } as never,
		undefined,
		undefined,
		{} as never,
	);
	const elidedText = texts(elided);
	assert.match(elidedText, /<elided_chars>/);
	assert.ok(!elidedText.includes("re-broadcast after elision"), "elision step is not the re-broadcast");
	assert.ok(!elidedText.includes("[journal] "), "step 1 is off the standard digest cadence");

	b.countStep();
	const next = await tool.execute(
		"c2",
		{ command: "echo ok" } as never,
		undefined,
		undefined,
		{} as never,
	);
	const nextText = texts(next);
	assert.match(nextText, /\[journal — re-broadcast after elision\]/);
	assert.match(nextText, /# Goal/);
	assert.match(nextText, /keep the public API/);

	b.countStep();
	const again = await tool.execute(
		"c3",
		{ command: "node -e \"process.stdout.write('Y'.repeat(8000))\"" } as never,
		undefined,
		undefined,
		{} as never,
	);
	b.countStep();
	const after = await tool.execute(
		"c4",
		{ command: "echo still" } as never,
		undefined,
		undefined,
		{} as never,
	);
	assert.ok(!texts(again).includes("re-broadcast after elision"));
	assert.ok(!texts(after).includes("re-broadcast after elision"));
});

test("sh digest rides the tail at the band interval", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mini-seam-"));
	const ledger = createLedger(dir, "seam-2");
	const b = budget();
	const state = populated();
	state.lastJournalStep = -1;
	const seam = new JournalSeam();
	const supervisor = new Supervisor({ expectsWrite: false, tuning: BANDS.quick });
	const tool = createShTool({
		cwd: process.cwd(),
		budget: b,
		ledger,
		supervisor,
		lastJournalStep: () => state.lastJournalStep,
		journal: state,
		seam,
	});

	const run = async (command: string) => {
		b.countStep();
		return texts(
			await tool.execute("c", { command } as never, undefined, undefined, {} as never),
		);
	};

	assert.ok(!(await run("echo a")).includes("[journal] "), "step 1: off-interval");
	assert.ok(!(await run("echo b")).includes("[journal] "), "step 2: off-interval");
	assert.ok(!(await run("echo c")).includes("[journal] "), "step 3: off-interval");

	const atFour = await run("echo d");
	assert.match(atFour, /\[journal\] /);
	assert.ok(!atFour.includes("[supervisor] No journal update"), "fresh enough at step 4 for quick band");
	assert.equal(atFour.split("\n").filter((l) => l.startsWith("[journal] ")).length, 1);
});
