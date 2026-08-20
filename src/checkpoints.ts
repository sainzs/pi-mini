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
 * back to any recorded intermediate; the index also lists untracked files each
 * snapshot knew about (their content is not in the diff — noted honestly).
 *
 * Cost discipline: snapshots only run after commands the supervisor classifies
 * as write-ish, each is one `git status` plus (on change) one `git diff` —
 * tens of milliseconds, never on the model's critical path. Patches are
 * size-capped and count-capped; a run cannot fill a disk by flailing.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendRecord } from "./ledger.ts";
import { fingerprint, git, porcelainPaths } from "./lease.ts";

const MAX_PATCH_BYTES = 256 * 1024;
const MAX_CHECKPOINTS = 40;

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

			const diff = await git(this.cwd, ["diff", "HEAD", "--binary"]);
			const seqLabel = String(this.seq).padStart(3, "0");
			let patchFile: string | undefined;
			let note: string | undefined;
			if (diff.length > 0 && Buffer.byteLength(diff) <= MAX_PATCH_BYTES) {
				patchFile = join(this.dir, `${seqLabel}.patch`);
				writeFileSync(patchFile, diff, "utf-8");
			} else if (diff.length > 0) {
				note = `diff ${Buffer.byteLength(diff)} bytes exceeds ${MAX_PATCH_BYTES}-byte cap; paths recorded, patch skipped`;
			}

			// Untracked paths are not in `git diff HEAD`; list them so the caller
			// knows what a rollback would NOT remove.
			const tracked = new Set(
				await git(this.cwd, ["ls-files"]).then((s) => s.split("\n").filter(Boolean)),
			);
			const untracked = paths.filter((p) => !tracked.has(p));

			this.latestPaths = paths;
			appendRecord(join(this.dir, "index.ndjson"), {
				seq: this.seq,
				step,
				paths,
				...(patchFile ? { patch: patchFile } : {}),
				...(untracked.length ? { untrackedNotPatched: untracked } : {}),
				...(note ? { note } : {}),
			});
			this.seq++;
		} catch {
			// git hiccup (lock, fs race): skip this checkpoint, never fail the step.
		}
	}
}
