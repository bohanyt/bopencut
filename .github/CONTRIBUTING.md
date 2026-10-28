# Contributing

bopencut is a personal project developed in stages according to [GOAL.md](../GOAL.md). Issues and suggestions are welcome; external PRs may not be accepted if they do not align with the stages.

Rules for every change:
- One stage or fix = one branch + one PR to `main`.
- CI must pass: `bun run build`, `bunx tsc --noEmit -p .`, and `bun test` in `apps/web`.
- The PR description includes the change, the "Done when" criteria from GOAL.md, and test evidence.
- Rules for agents changing code are in [AGENTS.md](../AGENTS.md).
