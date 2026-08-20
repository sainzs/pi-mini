# Release check

Overall: **PASS**

- Git HEAD: `3f5c3f1b0737baf62b20bd01c70738a8ed8967eb`
- Live mode: skipped
- Test files: tests/contract.test.ts, tests/isolation.test.ts, tests/jspace.test.ts, tests/unit.test.ts

## Model list

- `azure-foundry-claude/claude-fable-5` — not run (--live was not supplied)
- `azure-foundry/DeepSeek-V4-Flash-0731` — not run (--live was not supplied)

## Status

| Step | Check | Status | Exit code | Duration | Evidence |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | typecheck | PASS | 0 | 2322 ms | `01-typecheck.log` |
| 2 | tests | PASS | 0 | 1292 ms | `02-tests.log` |
| 3 | live-priced-claude-fable-5 | SKIPPED | n/a | 0 ms | `03-live-priced-claude-fable-5.log` |
| 4 | live-zero-priced-deepseek | SKIPPED | n/a | 0 ms | `04-live-zero-priced-deepseek.log` |

Evidence directory: `/Users/ssainz/Code/lab/pi-mini/findings/release-2026-08-20-1427`
