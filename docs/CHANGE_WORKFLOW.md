# Change Workflow

Constraints that apply to every change live in [RULES.md](RULES.md). This file is the procedure.

## Behavior Changes

1. Read `GOAL.md` if present, then the owning file and test in [REFERENCE_MAP.md](REFERENCE_MAP.md).
2. Add or update the smallest failing test.
3. Run the focused test and confirm the expected failure.
4. Implement the minimal change.
5. Run the focused test, then `npm test && npm run format:check`.
6. Update the README, the node help text, and the relevant `docs/` file when public behavior changes.

## Connection Changes

Update [CONNECTIONS.md](CONNECTIONS.md) and `test/connections.test.js`. Run the Docker topology matrix when it is available (see [TESTING.md](TESTING.md)).

## Scheduler Changes

Update `test/scheduler.test.js`. Legacy repeat behavior must keep using exact scheduler ids.

## Editor Changes

Update `bull-queue.html`, the static editor contract test, and Playwright coverage.
