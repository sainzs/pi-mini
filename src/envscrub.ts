/**
 * Env scrubbing for summoned-run shells.
 *
 * Threat, verified 2026-08-20 against @earendil-works/pi-coding-agent 0.83.0
 * (`dist/core/tools/bash.js`): `resolveSpawnContext` builds every child's
 * environment from `{ ...getShellEnv() }` — the full parent environment minus
 * four `PI_SESSION_*` keys — and that object is handed verbatim to
 * `spawn()`. So every `sh` command a summoned run executes sees
 * AZURE_API_KEY, AWS_BEARER_TOKEN_BEDROCK, and whatever else the parent
 * shell carries. No child needs any of it: provider calls happen in-process
 * in the parent session; the child shell only runs builds, tests and reads.
 * And the brief is semi-trusted input (the envelope already labels child
 * output "data, not instructions"), so a prompt-injected brief is one
 * `curl $AZURE_API_KEY` away from exfiltrating the parent's credentials.
 *
 * Policy: a small allowlist documents what a shell needs to function; a
 * case-insensitive name denylist is the security boundary; everything else
 * passes, because builds legitimately need odd variables and an allowlist
 * that captured all of them would be a second security boundary pretending
 * to be documentation. `NODE_OPTIONS` is dropped explicitly — it is not a
 * secret but a code-injection channel: `--import`/`-r` under it run
 * arbitrary modules inside any Node process the build happens to start.
 */

/**
 * Names the child shell genuinely needs, kept verbatim.
 * Documented intent, not the security boundary — see `SECRET_NAME`.
 */
const ALLOWLIST = new Set([
	"PATH",
	"HOME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"SHELL",
	"USER",
	"LOGNAME",
	"TZ",
	"COLUMNS",
	"EDITOR",
	"PAGER",
	// Toolchain roots: builds need to find their compilers and package stores.
	"FNM_DIR",
	"NVM_DIR",
	"CARGO_HOME",
	"RUSTUP_HOME",
	"GOPATH",
	"GOROOT",
	"JAVA_HOME",
	"PYENV_ROOT",
	"VIRTUAL_ENV",
]);

const HOMEBREW_PREFIX = "HOMEBREW_";

/**
 * The actual security boundary: any name carrying one of these fragments is
 * dropped. Case-insensitive by design — `my_TOKEN` is no safer than `MY_TOKEN`.
 */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|PRIVATE/i;

/** Code-injection channel, not a credential — dropped all the same. */
const NODE_OPTIONS = "NODE_OPTIONS";

/**
 * Return a copy of `env` with credentials and injection channels removed.
 *
 * The input object is never mutated; the result is a fresh object so the
 * caller's environment (and the bash tool's resolved context) stays
 * untouched between child spawns.
 */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const name of Object.keys(env)) {
		if (name === NODE_OPTIONS) continue;
		// Allowlist wins: keep documented names even when they look secret-ish
		// (e.g. HOMEBREW_GITHUB_API_TOKEN is a local toolchain capability).
		if (ALLOWLIST.has(name) || name.startsWith(HOMEBREW_PREFIX)) {
			out[name] = env[name];
			continue;
		}
		if (SECRET_NAME.test(name)) continue;
		out[name] = env[name];
	}
	return out;
}
