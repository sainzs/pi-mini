# Changelog

All notable changes to this project are documented here. Reconstructed
retroactively from git history and [`PLAN.md`](PLAN.md). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-08-20

A model-capability record: ten mechanisms shipped, each tied to the worker
model whose evidence-backed label the work names. The run from 0.3.0 to 0.4.0
was executed by a **droid worker fleet**, with per-commit worker-model
attribution recorded in the git log commit bodies (`droid exec …`) and each
commit carried an overseer verification.

- **gate ground truth** — refusal and yielded-submit behaviour now measured; the harness executes
  `accept` at gate time instead of containment-matching the child's command, closing the echo-gaming
  vector — *DeepSeek V4 Flash 0731*.
- **throttle refund** — burned steps refunded and re-paced on retryable provider throttle, with backoff
  and a throttled exit reason — *DeepSeek V4 Flash 0731*.
- **env scrub** — summoned `sh` commands no longer inherit credentials; runs get a filtered environment —
  *DeepSeek V4 Flash 0731*.
- **seam re-broadcast** — the journal digest re-broadcasts its settled state when the ledger stalls —
  *Claude Fable 5*.
- **checkpoint intent-to-add** — untracked files enter the patch via `git intent-to-add` so rollback
  removes them — *Claude Fable 5*.
- **release-check** — the `scripts/release-check.ts` release-evidence gate, exit codes observed by
  construction — *DeepSeek V4 Flash 0731*.
- **eval harness** — `scripts/eval.ts` turns default-model claims into reproducible measurements plus
  this capability record — *DeepSeek V4 Flash 0731*.
- **type seams** — typed seam threaded through tools/runner with zero casts at model resolution —
  *Claude Fable 5*.
- **summon queue** — the concurrency queue serializing summoned runs with per-provider pacing —
  *DeepSeek V4 Flash 0731*.
- **context-ceiling recovery** — halved observation retention on overflow, then terminal recovery when
  the ceiling keeps hitting — *Claude Fable 5*.

**Live evidence** (both in `eval/results/`): the same 8-task sweep ran two
models — **DeepSeek V4 Flash 0731 8/8 at $0.00** (billed on a zeroed Foundry
cost table; step/wall budgets bind) versus **claude-fable-5 7/8 at ~$0.80**,
whose single "failure" (task 06, an impossible accept predicate) was an honest
impossibility report submitted through the yielded gate for a spec-literal
judge. The live release gate **`findings/release-2026-08-20-1615`** passed:
typecheck, unit + isolation tests, and both live smokes (a priced fable-5 run
and a zero-priced DeepSeek run) with exit codes observed by construction.

## [0.3.0] — 2026-08-20

The J-Space control plane: v0.2 verified the *result*, v0.3 governs the
*process*, porting J-Space Cognition Suite V3.6 inference-time control
semantics.

- **Journal** — the run ledger: `goal / core / verified / open / next`, capped
  full-state writes persisted to `runs/<id>/journal.md`.
- **Submit gate** — bridge-before-conclusion: `submit` rejected while
  `verified` is empty (and until a declared `accept` has been observed
  passing), yielding after 2–3 rejections with the envelope labelled
  `gateOverridden`.
- **Supervisor** — seam refresh and inertia breaks: ≤350-char nudges ride the
  `sh` result tail once per cooldown on repeated commands, read-only drift, or
  stale journals.
- **Checkpoints** — differential recovery: `git diff HEAD` snapshots to
  `runs/<id>/checkpoints/NNN.patch` on dirty-set movement; rollback to any
  recorded intermediate.
- **Bands** — discrete entry routing `quick | standard | deep`, treating
  behavior bands as attractors rather than a continuous depth knob.
- **`/mini` TTY command** — the same runtime as a slash command in interactive
  sessions.
- **Model routing** — summoned runs default to
  `azure-foundry/DeepSeek-V4-Flash-0731`, with `PI_MINI_MODEL` override and
  inheritance-fallback for bad specs (never a silent dead binding).
- **Rename** — project renamed `pi-mini-agent` → **`pi-mini`**.

## [0.2.0] — 2026-08-07

The verification contract: a child's self-report is a verification *request*,
not a result.

- **`accept`** — caller-defined definition of done, executed by the harness in
  the cwd after the run (30 s timeout, capped output); `submitted` +
  `verified: FAIL` is a failure envelope.
- **`lease`** — path/glob patterns the child may change; git-diffed after the
  run so `files changed (observed)` comes from git, not the model; claim
  mismatches and lease violations both fail the envelope.
- **`binding_error`** — dead key/disabled model/missing base URL classified as
  its own exit reason so a dead binding can never read as success.
- **Routing rows** — every summon appends model id, `verified`, lease verdict,
  observed-change count and cost to `audit.ndjson`.
- **Live contract smoke** — verified on `azure/gpt-5.6-sol` at $0.13 total.

## [0.1.0] — 2026-08-07

Baseline (`pi-mini-agent` 0.1.0, pre verified-dispatch work): a bounded,
mini-swe-agent-style task runtime that any pi agent can summon on demand as a
dynamic workflow — hard step/wall/spend budgets, one `sh` action per step,
explicit submission, and a capped fixed-schema result envelope.

[0.1.0]: https://github.com/sainzs/pi-mini/releases/tag/v0.1.0
[0.2.0]: https://github.com/sainzs/pi-mini/releases/tag/v0.2.0
[0.3.0]: https://github.com/sainzs/pi-mini/releases/tag/v0.3.0
[0.4.0]: https://github.com/sainzs/pi-mini/releases/tag/v0.4.0
