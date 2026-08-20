# Release check

Overall: **PASS**

- Git HEAD: `1f31e85dcd75b8bdc14c105c4e2ef9b1897294c9`
- Live mode: skipped
- Test files: tests/ceiling.test.ts, tests/checkpoints.test.ts, tests/contract.test.ts, tests/envscrub.test.ts, tests/gate.test.ts, tests/isolation.test.ts, tests/jspace.test.ts, tests/queue.test.ts, tests/seam.test.ts, tests/throttle.test.ts, tests/unit.test.ts

## Model list

- `azure-foundry-claude/claude-fable-5` — not run (--live was not supplied)
- `azure-foundry/DeepSeek-V4-Flash-0731` — not run (--live was not supplied)

## Status

| Step | Check | Status | Exit code | Duration | Evidence |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | typecheck | PASS | 0 | 2898 ms | `01-typecheck.log` |
| 2 | tests | PASS | 0 | 1633 ms | `02-tests.log` |
| 3 | live-priced-claude-fable-5 | SKIPPED | n/a | 0 ms | `03-live-priced-claude-fable-5.log` |
| 4 | live-zero-priced-deepseek | SKIPPED | n/a | 0 ms | `04-live-zero-priced-deepseek.log` |

Evidence directory: `/Users/ssainz/Code/lab/pi-mini/findings/release-2026-08-20-1539`
