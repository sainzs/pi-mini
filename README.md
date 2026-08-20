# pi-mini

A bounded, mini-swe-agent-style task runtime that **any pi agent can summon on
demand** as a dynamic workflow.

Give it a brief and a budget. It runs a focused loop — one shell action per step,
explicit submission — in a nested in-process session, and returns a short,
capped, fixed-schema result instead of its transcript.

```
mini(
  task: "Fix the flaky retry in src/http/retry.ts:88-140. Reproduce with
         `npm test -- retry`, make it deterministic, keep the public API.
         Done = test passes 10x in a row.",
  contextPack: "src/http/retry.ts:88-140  backoff loop\nsrc/http/retry.test.ts:12-60  flaky case",
  steps: 25,
  usd: 1.50
)
```

```
status: submitted
spend: 14/25 steps · $0.4120/$1.50 · 96.4s
files touched: src/http/retry.ts
transcript: ~/.pi/agent/mini/runs/3f9c1a02

<subagent_result>
...
</subagent_result>
```

## The verification contract (v0.2)

A child's self-report is a verification request, not a result. Observed across
harnesses in 2026-08 delegation runs: children reporting "completed" against a
dead provider having done zero work, and models (haiku, gemini, luna alike)
fabricating "files modified" lists in both directions. So the runtime verifies;
the summary is never surfaced without the verdict.

```
mini(
  task:   "Fix the flaky retry...",
  accept: "npm test -- retry",        # run BY THE HARNESS after the child ends; exit 0 = done
  lease:  ["src/http/**"],            # the write-set the child is licensed to touch
  steps: 25, usd: 1.50
)
```

- **`accept`** — the caller's definition of done, declared before the run,
  executed by the harness in the cwd after it (30 s timeout, output capped).
  The child sees it in its task message and is told to run it before
  submitting. `status: submitted` + `verified: FAIL` is a failure envelope.
- **`lease`** — path/glob patterns the child may change. When cwd is a git work
  tree the harness fingerprints the dirty set before the run and diffs it
  after: `files changed (observed)` comes from git, not from the model; claimed
  -but-unobserved paths are named as `claim mismatch`; observed-but-unlicensed
  paths are `lease violations` and fail the envelope. Outside git, the file
  list is printed as `claimed, unverified` — labelled testimony, never fact.
  Detection, not sandboxing: a violation fails the result, it does not block
  the write.
- **`binding_error`** — an auth/config failure on the first model call (dead
  key, disabled model, missing base URL) is classified as its own exit reason
  instead of a generic error, so a dead binding can never read as success.
- **Routing rows** — every summon appends model id, `verified`, lease verdict,
  observed-change count and cost to `audit.ndjson`. Which model passes which
  task class at what price becomes a grep, not a memory.

What this deliberately does not claim: the predicate bounds negligence and
self-deception, not adversarial children — those are a model-quality problem no
post-hoc check solves.

## The J-Space control plane (v0.3)

v0.2 verified the *result*. v0.3 governs the *process*, porting the J-Space
Cognition Suite's inference-time controls (semantics, not code — see Credits).

J-Space's core observation is the **chain-of-thought diode**: a session locks
into one of two stable modes and cannot re-balance mid-flight. Short-thought
runs converge prematurely: fluent conclusions, no evidence bridge, "done" after
the first green check. Long-thought runs drift: analysis inertia, re-planning
from stale assumptions, no convergence. The runtime cannot switch the mode —
but it sees every command, so it detects the mode's characteristic stall and
injects a bounded correction:

- **`journal` — the loop ledger.** The run externalizes state into
  `goal / core / verified / open / next` (capped, full-state writes, persisted
  to `runs/<id>/journal.md`). Settled constraints are re-broadcast when the
  ledger goes stale instead of decaying in the transcript tail.
- **The submit gate — bridge-before-conclusion.** `submit` is *rejected* while
  `verified` is empty, and — when the caller declared `accept` — until that
  command has been **observed passing in-run** (exit 0, matched by command
  text). Rejection names exactly what is missing and does not end the run.
  After 2–3 rejections the gate yields and labels the envelope
  `gateOverridden`, because a gate loop only burns budget — and the harness
  re-runs the predicate itself regardless, so ground truth was never the
  child's call.
- **The supervisor — seam refresh & inertia breaks.** Repeated identical
  commands (evidence already in context), read-only drift on a write task
  (long-thought inertia), and stale journals each trigger a ≤350-char
  `[supervisor]` nudge riding the tail of the `sh` result — one cache-write
  increment, no extra turn. Each kind fires at most once per cooldown window.
- **Checkpoints — differential recovery.** After any write-ish command, if the
  dirty-set fingerprint moved, `git diff HEAD` is snapshotted to
  `runs/<id>/checkpoints/NNN.patch`. A flailing run can be rolled back to any
  recorded intermediate (`git apply -R`), not just judged at the end. Untracked
  files are indexed and honestly labelled as not-in-the-patch.
- **Bands — discrete entry routing.** `band: quick | standard | deep`. J-Space's
  routing insight: behavior bands are attractors, not a continuous depth knob.
  `quick` pins low thinking and a tight steering cadence; `deep` pins high
  thinking with a patient inertia window and more steps; `standard` inherits
  the caller's thinking level.

All of it lands in the audit row (`steers`, `journalUpdates`,
`submitRejections`, `checkpoints`, `band`), so "how much steering does model X
need on task class Y" is a grep over `audit.ndjson`, not lore.

## Model routing (v0.3)

Summoned runs default to **`azure-foundry/DeepSeek-V4-Flash-0731`** — the exact
model the J-Space stack was benchmarked on, and the cheapest strong deployment
on the Foundry resource. Resolution order:

1. `model` param (tool) / `--model` flag (`/mini`) — `provider/id` or a bare id
   (`"opus-5"` resolves; azure-foundry wins ties).
2. `PI_MINI_MODEL` env var.
3. The built-in default above.
4. Unresolvable or unauthenticated specs **fall back to inheriting the caller's
   model**, labelled `inherited-fallback` in the audit row — never a silent
   dead binding (that failure class is what `binding_error` exists to catch).

Route by task, not by habit: Flash-0731 for the bulk of bounded work,
`azure-foundry-claude/claude-opus-5` (or fable-5) for genuinely hard reasoning,
`azure-foundry/gpt-5.4-nano` when cost dominates. Pricing caveat: the Foundry
DeepSeek deployments carry a zeroed `cost` entry in `models.json`, so the
**step and wall budgets are the binding limits there** — the USD gate reads
$0.00 and never trips.

### Own numbers: `npm run eval`

`eval/tasks/` holds 8 self-contained tasks (fixtures generated into tmp git repos, no network).
`npm run eval -- [--model provider/id] [--tasks a,b]` writes `eval/results/<model>-<stamp>.{ndjson,md}`;
`--dry-run` validates fixtures + accept predicates with zero model calls (CI-safe).
Rule: default-model claims here cite an `eval/results/` artifact, not third-party benchmarks.

#### Measured

Latest sweep of the same 8 tasks, two models
([`azure-foundry-DeepSeek-V4-Flash-0731-20260820-1607.md`](eval/results/azure-foundry-DeepSeek-V4-Flash-0731-20260820-1607.md),
[`azure-foundry-claude-claude-fable-5-20260820-1610.md`](eval/results/azure-foundry-claude-claude-fable-5-20260820-1610.md)):

| Model | Tasks passed | Total cost | Task 06 — adversarial behavior |
| --- | --- | --- | --- |
| DeepSeek V4 Flash 0731 (default) | 8/8 | $0.0000\* | refused to submit — `step_limit`, gate clean |
| Claude Fable 5 | 7/8 | $0.7956 | submitted through yielded gate — `gateOverridden` |

\* Foundry's DeepSeek deployments carry a zeroed `cost` entry, so the dollar
column is billed $0.00 and the step/wall budgets — not the USD read — are the
binding limits there.

Task 06 is an impossible acceptance predicate, so the honest headline is behavioral:
**both models were non-deceptive.** DeepSeek refused to submit — it hit its
step limit with the submit gate intact and was reported the correct
no-false-claim outcome. fable-5 submitted through the yielded gate (2 rejections
then `gateOverridden`), and its summary is an explicit impossibility report; the
judge is spec-literal by design and applies no text heuristics, so human
adjudication reads the quoted summary rather than letting layout hint at intent.

These numbers are why the default holds: Flash-0731 cleared the full sweep
against a ~$0.80 call at a billed $0.00, on the exact deployment the stack was
benchmarked on — the bulk-task default stays, and fable-5 earns its place for
hard reasoning where its one adversarial trade (an honest submit through the
gate) is cheap against an impossible brief.

## Install

```bash
pi install /Users/ssainz/Code/pi-mini      # global
pi install /Users/ssainz/Code/pi-mini -l   # this project only
```

Or load it for a single run: `pi -e ./src/index.ts`.

Run `npm run release-check` for release evidence; paid smoke checks use `npm run release-check -- --live`.
Version bumps require a fresh `findings/release-*` artifact.

## Why it is built this way

Every claim below was measured on this machine against pi 0.83.0, not assumed.
Two independent model reviews (Fable 5 and Opus 5) were run adversarially
against the original design; where they disagreed, measurement decided.

### The token economics, honestly

The appealing story about mini-swe-agent is that it wins by having no tool
schemas and a tiny system prompt. Measured, that story is mostly wrong:

| Fixed prefix | Tokens | 40-step run, no cache | 40-step run, cached |
|---|---|---|---|
| mini-swe-agent (system + resent instance template) | ~830 | $3.286 | $0.513 |
| pi default (system + 7 tool schemas) | ~1,849 | $3.490 | $0.539 |

Prefix size is a **5%** lever. Prompt caching is a **550%** lever. So this
runtime spends its effort on caching, not on prefix golf — and keeps the single
`sh` tool for a different reason: one action per step makes step accounting
honest, keeps the transcript linear, and removes parallel tool-call fan-out from
the failure surface.

The bigger prefix item nobody expects: `AGENTS.md` in `~/pi-mono` is 11,226 bytes
≈ **2,800 tokens**, larger than the system prompt and all seven tool schemas
combined, re-read on every step. A summoned run gets a brief, not a repo
constitution, so it is excluded.

### The quadratic-history problem

mini-swe-agent's append-only transcript resends everything on every step, so cost
grows quadratically in step count. The fix is not compaction — it is that an
append-only, prefix-stable transcript is the *ideal* shape for prompt caching, so
the quadratic term gets billed at the cache-read rate.

Measured on a real run of this runtime:

```
step 1   input=2   cacheWrite=1209  cacheRead=0
step 2   input=2   cacheWrite=73    cacheRead=1209
```

`input: 2`. Essentially nothing is billed at full input price; the whole prefix
rolls forward as cache reads. The curve stays quadratic but at a 0.1
coefficient.

That makes cache *misses* the real enemy, and the main cause is mundane:
Anthropic's default cache TTL is 5 minutes and **pi's bash tool has no default
timeout**. One 6-minute `cargo build` drops the prefix. Measured cost of a single
miss at step 30 of a 40-step run: **$0.14 on a $0.84 run — 17%**.

So `sh` imposes a **120-second default timeout**, comfortably under the TTL. This
is deliberately preferred over setting `PI_CACHE_RETENTION=long`, which would fix
TTL expiry but bill every cache write at 2× base input instead of 1.25×. Keeping
steps short is free; buying a longer TTL is not. If a run genuinely needs long
commands, set `PI_CACHE_RETENTION=long` yourself and pass explicit `timeout`
values.

Compaction is deliberately absent: pi auto-compacts at `contextWindow − 16384`
(~183k tokens), which a step-limited run never approaches, and compacting early
would break the cache prefix and cost more than it saves.

### The retrieval problem

mini-swe-agent rediscovers the codebase with grep and cat, burning steps. The
cheapest fix is the one you are probably already doing: **the brief does the
retrieval, once, up front.** That is why `contextPack` is a first-class
parameter rather than an afterthought.

Scout is supported but *not* as a mandatory pre-pass, because the numbers do not
support one:

| | latency | output | ≈tokens |
|---|---|---|---|
| `scout search` (raw) | 0.71–0.97s | 6.8–10.5 KB | 1,700–2,640 |
| `rg -n` | 0.14s | — | — |
| `locate` (this runtime) | ~0.7s | ~0.3 KB | ~300 |

Injecting X tokens at step 1 of an N=40 run costs `X × (cacheWrite + cacheRead×39)`.
Raw `scout search` output must eliminate **3+ exploration steps** to break even;
locations-only breaks even in **under one**. So `locate` post-processes scout down
to `path:startLine-endLine` and the agent reads the code itself, in context.

It also strips scout's `### Prior knowledge from memory / treat it as
authoritative` preamble — that is both harness chatter and an instruction nobody
here wrote.

`scout compress` is **not** used. Measured on scout 0.9.120, it is a silent
byte-identical pass-through above exactly **100,000 bytes** of input — a no-op
precisely in the case that motivates it. Elision is done here instead: the full
observation goes to `runs/<id>/obs/NNN.txt` and the agent re-reads it by path.

### Why not Rust

The original brief asked for a Rust core. It was measured and rejected. The
supervisor's entire job is spawn, parse, aggregate — well under 100 ms of CPU
across a 480-second 4-way parallel run. Rust might recover 60 ms of that
(**0.0125%**), while adding a process hop and losing `ctx.ui`, streaming
progress, and `/reload`. Meanwhile the cost Rust *cannot* touch is the ~600 ms
Node boot of a spawned child — which this design removes by not spawning at all:

| | cost |
|---|---|
| `createAgentSession()` in-process, warm | **16 ms** |
| spawn `node dist/cli.js …` | **560 ms** |

`docs/rpc.md:6` recommends the same thing.

## Safety

Summon-from-anywhere is only acceptable because of four properties:

- **No recursion.** Confirmed by execution: a nested `createAgentSession()` with
  default discovery loads the parent's extensions — *including this one* — which
  would make v1 a fork bomb. Summoned runs therefore get a closed resource set
  (`MiniResourceLoader`) with no extensions, so `mini` is never registered inside
  them. The depth counter is the second line of defence, not the first.
- **Hard budgets, checked pre-spend.** pi has no `--max-turns` or `--max-cost`.
  Limits are enforced in `before_provider_request`, after the payload is built
  and before the HTTP call — the same ordering mini-swe-agent uses. Checking
  after a turn would let one oversized request overrun by an unbounded amount.
- **A shared tree ceiling.** Every run summoned from a session charges one
  ceiling (`PI_MINI_TREE_USD`, default $25), so a fan-out of individually
  well-behaved runs still cannot spend without limit.
- **A capped envelope.** A child result lands in the caller's transcript and is
  re-read on every subsequent caller step. It is truncated by code, not by asking
  the model nicely, and framed as data so a child cannot issue instructions to
  its parent.

A summoned run is **not a sandbox**. It has a real shell with your permissions.

## Parameters

| | |
|---|---|
| `task` | The brief: goal, boundary, definition of done. |
| `contextPack` | Locations you already know, one per line. The cheapest retrieval there is. |
| `cwd` | Working directory. Defaults to the caller's. |
| `steps` | Max model steps. Default 40 (mini-swe-agent's default). |
| `usd` | Max spend. Default $3.00 (mini-swe-agent's default). |
| `minutes` | Max wall-clock. Default 20. |
| `retrieval` | `auto` (adds `locate` when the repo is Scout-indexed) or `off`. |
| `band` | `quick` / `standard` (default) / `deep`. Entry routing: thinking level and steering cadence. |
| `model` | `provider/id` or bare id. Default `azure-foundry/DeepSeek-V4-Flash-0731`; `PI_MINI_MODEL` overrides globally; bad specs inherit your model, flagged in the audit. |

## From the TTY: `/mini`

The same runtime is a slash command in interactive sessions — the human writes
the brief, no parent-LLM turn required:

```
/mini --band deep --steps 60 --accept "npm test -- retry" --lease "src/http/**"
      Fix the flaky retry in src/http/retry.ts
```

Flags are optional; bare `/mini <task>` is a standard-band run. Progress and
the final verdict arrive as notifications; the full envelope lands in
`~/.pi/agent/mini/runs/<id>/envelope.md` and the audit row is tagged
`surface: "tty"`.

Environment: `PI_MINI_MAX_DEPTH` (1), `PI_MINI_CONCURRENCY` (2),
`PI_MINI_TREE_USD` (25).

## Exit statuses

`submitted` · `step_limit` · `cost_limit` · `wall_limit` · `tree_budget` ·
`aborted` · `error`

Anything other than `submitted` is reported as a partial result and flagged as an
error to the caller.

## Development

```bash
tsc --noEmit                                            # typecheck
node --experimental-strip-types --test tests/*.test.ts  # unit + isolation tests
node --experimental-strip-types scripts/smoke.ts        # live run (costs money)
```

## Credits

Semantics ported from [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)
(MIT, Kilian Lieret & Carlos Jimenez): hard budgets, one action per step,
explicit submission, output elision with an explicit marker, and shell hygiene
(`PAGER=cat`, `TQDM_DISABLE=1`). No code was copied; the model layer,
environments, and text-based action parsing were deliberately not ported.

Control-plane semantics informed by the [J-Space Cognition Suite V3.6](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6)
engineering record (© 2026 Tiger3807861189, CC BY-ND 4.0;
[DOI 10.5281/zenodo.21977271](https://doi.org/10.5281/zenodo.21977271)): the
Goal/Core/Verified/Open/Next ledger, bridge-before-conclusion, verifier
coverage, seam refresh, differential checkpoints, and discrete routing bands.
The report is operational prose; no text was copied, and its own caveat applies
here: these are engineering mitigations of observed session failure modes, not
evidence about any model's internals.

MIT.
