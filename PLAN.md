# pi-mini — plan

A mini-swe-agent-inspired **bounded task runtime**, exposed as a Pi tool that any
agent (top-level or nested) can summon on demand as a dynamic workflow.

Origin: `mini-swe-agent` (MIT, Kilian Lieret & Carlos Jimenez). We port its
*semantics* (hard budgets, one action per step, explicit submission, output
elision), not its code, model layer, or environments.

## Decisions (adjudicated from two independent reviews + own measurement)

| # | Decision | Why |
|---|---|---|
| D1 | **No Rust/native core.** One TypeScript extension. | Children would be Node anyway. Measured: in-process session 16–50 ms vs 560 ms spawn. Rust adds a process hop and loses `ctx.ui`, streaming, `/reload`. |
| D2 | **In-process `createAgentSession()`**, `SessionManager.inMemory()`. | 35× cheaper per summon than spawning. `docs/rpc.md:6` recommends it over subprocesses. No orphan sessions, no wire protocol. |
| D3 | **One `sh` tool, not markdown-parsed bash.** | The token case for "no tool schemas" is dead: measured 1,850 tok (pi, 7 tools) vs 830 tok (mini-swe) = **4.8%** of a cached 40-step run. Keep single-tool for *determinism* (one action/step, linear transcript, no parallel fan-out), not cost. Parsing ```` ```bash ```` would fight pi's turn loop for 54 tokens. |
| D4 | **Budgets enforced pre-spend in `before_provider_request`.** | The one thing pi genuinely lacks (no `--max-turns`/`--max-cost`). Mirrors mini-swe's check-before-`model.query` ordering. Post-hoc summing lets one 900k-token request overrun unbounded. |
| D5 | **`PI_CACHE_RETENTION=long` + mandatory per-command bash timeout.** | This is the *real* fix for quadratic history. Caching is worth 6.5× ($3.49→$0.54 on a 40-step Opus run). pi defaults to a 5-min TTL and its bash tool has **no default timeout** — one 6-min `cargo build` blows the cache and costs 17% of the whole run. |
| D6 | **No compaction.** | Auto-compaction fires at `contextWindow − 16384` ≈ 183k tokens. A step-limited run never reaches it. Compacting early would break the cache prefix and cost more than it saves. |
| D7 | **Observation ledger.** Full output to disk, bounded digest in context, agent re-opens by reference. | Converts "resend forever" into "pay once, re-read on demand". Uses pi's own bounded truncation, *not* `scout compress` (measured: silent no-op above exactly 100,000 bytes — broken precisely where it matters). |
| D8 | **Retrieval: caller-supplied `contextPack` is first-class; Scout is an optional lazy `locate` tool.** | Measured: a 2,100-token `scout search` must save **3+ steps** to break even; locations-only (~300 tok) breaks even under 1 step. Only 1 repo attached here; daemon holds 5.1 GB; unattached repos hard-error. Never a mandatory pre-pass, never in the prefix. |
| D9 | **Custom `MiniResourceLoader`: no extension discovery, no skills/prompts/themes, no context files, minimal system prompt.** | Fixes the **fork bomb** (confirmed by execution: nested `createAgentSession()` loads the parent's discovered extensions, including this one). Also drops `AGENTS.md` — 11,226 bytes ≈ 2,800 tok, larger than every tool schema combined. |
| D10 | **Depth cap + concurrency semaphore + capped result envelope + NDJSON audit.** | Makes summon-from-anywhere safe. Envelope cap prevents child transcripts poisoning the parent (re-read at cacheRead every parent step thereafter). |

## Cost model (Opus 2026 pricing, 40 steps, ~800 new tok/step)

| Prefix | No cache | Cached |
|---|---|---|
| 830 (mini-swe) | $3.286 | $0.513 |
| 1,849 (pi, 7 tools) | $3.490 | $0.539 |

Caching is a 550% lever; prefix size is a 5% lever. We optimize the former.
Resulting curve: `~0.1 · s · (P₀ + 250s)` token-equivalents — quadratic, but at
a 0.1 coefficient.

## Layout

| File | Role |
|---|---|
| `src/budget.ts` | Steps/USD/wall/depth ledger, pre-spend check, tree-shared |
| `src/prompt.ts` | mini-swe-style system prompt (~300 tok) |
| `src/loader.ts` | `MiniResourceLoader` — D9 |
| `src/ledger.ts` | Run dir, observation files, NDJSON audit |
| `src/tools.ts` | `sh` (forced timeout + ledger), `submit` (`terminate: true`), `locate` (optional Scout) |
| `src/envelope.ts` | Fixed, token-capped result envelope |
| `src/runner.ts` | Builds + drives one nested session |
| `src/index.ts` | Extension entry: `mini` tool, depth guard, semaphore |

## v0.3: the J-Space control plane

v0.2 verified results; v0.3 governs process, porting J-Space Cognition Suite
V3.6 semantics (ledger, bridge-before-conclusion, verifier coverage, seam
refresh, differential checkpoints, discrete bands):

| # | Decision | Why |
|---|---|---|
| J1 | **Structured `journal` tool, full-state writes, hard caps.** | Externalized state beats transcript memory against drift; last-write-wins is self-healing; caps are code, not pleas. |
| J2 | **Submit gate: `verified` entries + observed acceptance pass required; yields after 2–3 rejections, labelled `gateOverridden`.** | Bridge-before-conclusion as a contract. The gate bounds negligence; the harness's own predicate re-run remains ground truth, so yielding costs nothing but budget. |
| J3 | **Supervisor nudges ride the `sh` result tail, ≤350 chars, once per cooldown.** | The harness sees every command; steering at the observation seam costs one cache-write increment and no extra turn. |
| J4 | **Checkpoints are `git diff HEAD` snapshots, write-ish-triggered, size/count-capped.** | Recovery to a known-good intermediate instead of judge-at-the-end. Never on the model's critical path. |
| J5 | **Bands `quick\|standard\|deep`, not knobs; `standard` inherits thinking.** | J-Space's routing finding: the middle is an unstable transition zone, not a usable intermediate. |
| J6 | **TTY surface `/mini` summons directly.** | The human writes the brief; no parent-LLM turn. Same budgets, same audit. |

## Non-goals (v1)

Rust/native binaries; chains and DAGs (the calling agent sequences tool calls);
background daemon; git worktrees; RPC warm pool; direct provider clients;
`scout compress`; mandatory retrieval pre-pass; markdown action parsing;
`max_consecutive_format_errors` (native tool-calling makes it moot).

## Acceptance

- Budget stops within 1 step / $0.01 / 2 s of the limit.
- Depth > cap refuses with a clear error; no fork bomb.
- Parent-context payload ≤ 8 KB p99.
- Zero orphan processes 3 s after abort.
- Cache: `cacheRead` grows monotonically across steps on a live smoke run.
