# Release check

Overall: **PASS**

- Git HEAD: `e5ab8ac6ab1beeb83674f24b43bf2354f5700326`
- Live mode: enabled
- Test files: tests/ceiling.test.ts, tests/checkpoints.test.ts, tests/contract.test.ts, tests/envscrub.test.ts, tests/gate.test.ts, tests/isolation.test.ts, tests/jspace.test.ts, tests/queue.test.ts, tests/seam.test.ts, tests/throttle.test.ts, tests/unit.test.ts

## Model list

- `azure-foundry-claude/claude-fable-5` — used
- `azure-foundry/DeepSeek-V4-Flash-0731` — used

## Status

| Step | Check | Status | Exit code | Duration | Evidence |
| ---: | --- | --- | ---: | ---: | --- |
| 1 | typecheck | PASS | 0 | 2713 ms | `01-typecheck.log` |
| 2 | tests | PASS | 0 | 1580 ms | `02-tests.log` |
| 3 | live-priced-claude-fable-5 | PASS | 0 | 48986 ms | `03-live-priced-claude-fable-5.log` |
| 4 | live-rate-limit-delay | PASS | 0 | 75016 ms | `04-live-rate-limit-delay.log` |
| 5 | live-zero-priced-deepseek | PASS | 0 | 13667 ms | `05-live-zero-priced-deepseek.log` |

Evidence directory: `/Users/ssainz/Code/lab/pi-mini/findings/release-2026-08-20-1615`
