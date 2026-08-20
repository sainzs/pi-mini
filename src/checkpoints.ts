/**
 * Checkpoints — J-Space's differential-testing-and-recovery mechanism, in git.
 *
 * A summoned run that starts flailing used to leave exactly two options: take
 * the end state or take nothing. J-Space's answer is to bind progress to
 * checkpoints so a run can be *recovered to a known-good intermediate*, not
 * just judged at the end. Here: after any write-ish command, if the dirty-set
 * fingerprint moved, snapshot `git diff HEAD` to `checkpoints/NNN.patch`.
 *
 * Recovery is then a one-liner for the caller: `git apply -R <patch>` rolls
 * back to any recorded intermediate. Untracked files are intent-to-add'd ahead
 * of the diff so brand-new files land IN the patch — a rollback removes them
 * too — then the index reset leaves their untracked status untouched. Above
 * 200 untracked paths the recorder falls back to listing them as
 * `untrackedSkipped` and leaving them out of the patch (noted honestly).
 *
 * Cost discipline: snapshots only run after commands the supervisor classifies
 * as write-ish, each is one `git status` plus (on change) one `git diff` and
 * one `git ls-files` — tens of milliseconds, never on the model's critical
 * path — plus a paired add/reset only when untracked files exist. Patches are
 * size-capped and count-capped; a run cannot fill a disk by flailing.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendRecord } from "./ledger.ts";
import { fingerprint, git, porcelainPaths } from "./lease.ts";

const MAX_PATCH_BYTES = 256 * 1024;
const MAX_CHECKPOINTS = 40;
/** Intent-to-add cap: a huge untracked set would balloon the patch and the reset. */
const MAX_INTENT_TO_ADD_PATHS = 200;

export class CheckpointRecorder {
	private readonly cwd: string;
	private readonly root: string | undefined;
	readonly dir: string;
	private lastFingerprintSet = "";
	private seq = 0;
	/** Paths covered by the newest snapshot, for the envelope. */
	latestPaths: string[] = [];

	/** @param root git work-tree root; undefined makes the recorder inert. */
	constructor(cwd: string, runDir: string, root: string | undefined) {
		this.cwd = cwd;
		this.root = root;
		this.dir = join(runDir, "checkpoints");
	}

	get count(): number {
		return this.seq;
	}

	get active(): boolean {
		return this.root !== undefined;
	}

	/**
	 * Snapshot when the dirty set moved. Called by the `sh` wrapper after
	 * write-ish commands only. Never throws: recovery aids must not break runs.
	 */
	async maybeSnapshot(step: number): Promise<void> {
		if (!this.root) return;
		try {
			const raw = await git(this.cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
			const paths = porcelainPaths(raw);
			const fpSet = paths
				.map((rel) => `${rel}:${fingerprint(this.root as string, rel)}`)
				.sort()
				.join("\n");
			if (fpSet === this.lastFingerprintSet) return;
			this.lastFingerprintSet = fpSet;

			if (this.seq === 0) mkdirSync(this.dir, { recursive: true });
			if (this.seq >= MAX_CHECKPOINTS) {
				// Rotate: keep the newest MAX_CHECKPOINTS patches on disk.
				const stale = join(this.dir, `${String(this.seq - MAX_CHECKPOINTS + 1).padStart(3, "0")}.patch`);
				try {
					rmSync(stale, { force: true });
				} catch {
					// rotation is best-effort
				}
			}

			// Untracked paths are absent from `git diff HEAD` by default.
			// Intent-to-add them (empty index blob) so brand-new files land IN the
			// patch and a rollback removes them; capped because a giant untracked
			// set (build output, vendored trees) would balloon the patch and the
			// reset. The reset below restores their untracked status.
			const tracked = new Set(
				await git(this.cwd, ["ls-files"]).then((s) => s.split("\n").filter(Boolean)),
			);
			const untracked = paths.filter((p) => !tracked.has(p));

			let intents: string[] = [];
			let untrackedSkipped: string[] = [];
			let note: string | undefined;
			if (untracked.length > MAX_INTENT_TO_ADD_PATHS) {
				untrackedSkipped = untracked;
				note = `${untracked.length} untracked files exceed the ${MAX_INTENT_TO_ADD_PATHS}-path intent-to-add cap; patch excludes them`;
			} else if (untracked.length > 0) {
				try {
					await git(this.cwd, ["add", "--intent-to-add", "--", ...untracked]);
					intents = untracked;
				} catch {
					// Fall back to the old exclusion behavior, recorded honestly.
					untrackedSkipped = untracked;
					note = "git add --intent-to-add failed; patch excludes untracked files";
				}
			}

			let diff: string;
			try {
				diff = await git(this.cwd, ["diff", "HEAD", "--binary"]);
			} finally {
				if (intents.length > 0) {
					try {
						await git(this.cwd, ["reset", "-q", "--", ...intents]);
					} catch {
						// Restoring untracked status is best-effort and must never
						// throw; a stuck intent-to-add entry shows in the next status.
					}
				}
			}

			const seqLabel = String(this.seq).padStart(3, "0");
			let patchFile: string | undefined;
			if (diff.length > 0 && Buffer.byteLength(diff) <= MAX_PATCH_BYTES) {
				patchFile = join(this.dir, `${seqLabel}.patch`);
				writeFileSync(patchFile, diff, "utf-8");
			} else if (diff.length > 0) {
				note = [note, `diff ${Buffer.byteLength(diff)} bytes exceeds ${MAX_PATCH_BYTES}-byte cap; paths recorded, patch skipped`]
					.filter(Boolean)
					.join("; ");
			}

			this.latestPaths = paths;
			appendRecord(join(this.dir, "index.ndjson"), {
				seq: this.seq,
				step,
				paths,
				...(patchFile ? { patch: patchFile } : {}),
				...(intents.length ? { untrackedPatched: intents } : {}),
				...(untrackedSkipped.length ? { untrackedSkipped } : {}),
				...(note ? { note } : {}),
			});
			this.seq++;
		} catch {
			// git hiccup (lock, fs race): skip this checkpoint, never fail the step.
		}
	}
}
