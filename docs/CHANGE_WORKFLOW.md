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

Update [CONNECTIONS.md](CONNECTIONS.md) and `test/connections.test.js`. Run the Docker deployment matrix when it is available (see [TESTING.md](TESTING.md)); it covers the Redis topologies and both PostgreSQL fixtures.

A change that touches shared connection code has to be checked on both backends, because they divide ownership differently: Redis connections are created here, PostgreSQL connections are owned by BullMQ. `test/redis-characterization.test.js` exists to catch drift in the Redis descriptors and options and must pass untouched; `npm run test:integration` runs the backend-neutral flows against both stores.

## Scheduler Changes

Update `test/scheduler.test.js`. Native Job Scheduler lookup and removal must keep using exact scheduler ids.

## Editor Changes

Update `bull-queue.html`, the static editor contract test, and Playwright coverage.
