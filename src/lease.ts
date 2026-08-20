/**
 * The write-set lease — the harness computes what changed; the model's claim is
 * decorative.
 *
 * Cross-harness evidence (haiku, gemini, luna, 2026-08 routing-ledger rows, plus
 * this repo's own reorg run): the "files I modified" channel from a model is
 * unreliable in BOTH directions — phantom edits reported, real edits omitted.
 * So the envelope's `filesChanged` must come from observation, not testimony.
 *
 * Mechanism: when `cwd` is inside a git work tree, fingerprint the dirty set
 * before the run (`git status --porcelain -z`, plus size+mtime of each dirty
 * path) and diff it after. A file counts as changed when it enters/leaves the
 * porcelain set or its fingerprint moves. This is detection, not prevention —
 * a lease violation fails the run's envelope; it does not block the write.
 * Prevention would need a sandbox and would cost the in-process architecture.
 *
 * Blind spots, stated honestly:
 *  - not a git repo → observation is impossible at acceptable cost; the
 *    envelope says so and falls back to the claim, labelled as unverified.
 *  - a file edited and byte-identically restored → invisible (no net change,
 *    which is the correct verdict for a lease).
 *  - changes inside .git itself, or in ignored files → out of scope; ignored
 *    files are build noise, .git mutation is a different threat class.
 */

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;

export interface LeaseBaseline {
	git: boolean;
	/** repo-relative dirty/untracked path -> fingerprint at capture time. */
	entries: Map<string, string>;
	/** Absolute path of the work-tree root, so observations are repo-relative. */
	root?: string;
}

export async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 32 * 1024 * 1024,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
	});
	return stdout;
}

/** Parse `git status --porcelain=v1 -z` into repo-relative paths. */
export function porcelainPaths(raw: string): string[] {
	const out: string[] = [];
	const fields = raw.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (!field || field.length < 4) continue;
		const status = field.slice(0, 2);
		out.push(field.slice(3));
		// Rename/copy entries carry the original path in the next NUL field.
		if (status[0] === "R" || status[0] === "C") i++;
	}
	return out;
}

export function fingerprint(root: string, rel: string): string {
	try {
		const s = statSync(join(root, rel));
		return `${s.size}:${Math.round(s.mtimeMs)}`;
	} catch {
		return "absent";
	}
}

export async function captureLeaseBaseline(cwd: string): Promise<LeaseBaseline> {
	let root: string;
	try {
		root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
	} catch {
		return { git: false, entries: new Map() };
	}
	const raw = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	const entries = new Map<string, string>();
	for (const rel of porcelainPaths(raw)) entries.set(rel, fingerprint(root, rel));
	return { git: true, entries, root };
}

export interface ObservedChanges {
	/** Present only when observation was possible (git repo). */
	observed?: string[];
	/** Human-readable reason when observation was impossible. */
	unverifiable?: string;
}

export async function observeChanges(cwd: string, baseline: LeaseBaseline): Promise<ObservedChanges> {
	if (!baseline.git || !baseline.root) {
		return { unverifiable: "not a git work tree; file changes cannot be observed" };
	}
	let raw: string;
	try {
		raw = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	} catch (error) {
		return {
			unverifiable: `git status failed after the run: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const after = new Map<string, string>();
	for (const rel of porcelainPaths(raw)) after.set(rel, fingerprint(baseline.root, rel));

	const changed = new Set<string>();
	for (const [rel, fp] of after) {
		const before = baseline.entries.get(rel);
		if (before === undefined || before !== fp) changed.add(rel);
	}
	for (const rel of baseline.entries.keys()) {
		if (!after.has(rel)) changed.add(rel); // was dirty, now clean/gone: state moved
	}
	return { observed: [...changed].sort() };
}

/**
 * Micro-glob for lease patterns. Supports `**` (any depth), `*` (within a
 * segment), `?`. A pattern with no glob chars licenses the exact path and, when
 * it names a directory, everything under it.
 */
export function leaseMatch(pattern: string, path: string): boolean {
	if (!/[*?]/.test(pattern)) {
		const p = pattern.replace(/\/+$/, "");
		return path === p || path.startsWith(`${p}/`);
	}
	const rx = pattern
		.split("**")
		.map((part) =>
			part
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, "[^/]*")
				.replace(/\?/g, "[^/]"),
		)
		.join(".*");
	return new RegExp(`^${rx}$`).test(path);
}

/** Paths in `observed` that no lease pattern licenses. */
export function leaseViolations(observed: string[], lease: string[]): string[] {
	if (lease.length === 0) return [];
	return observed.filter((path) => !lease.some((pattern) => leaseMatch(pattern, path)));
}
