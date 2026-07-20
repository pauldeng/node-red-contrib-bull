# Contributing

## Development Setup

Use Node.js 22.9 or newer (the development dependency on Node-RED 5 requires it) and install dependencies from the lockfile:

```sh
npm ci
```

Run the default test suite before opening a pull request:

```sh
npm test
```

## Change Rules

- Keep BullMQ pinned to exactly `5.80.9`.
- Do not reintroduce `bull` or `sprintf-js`.
- Preserve legacy node types: `bull-queue-server`, `bull cmd`, and `bull run`.
- Keep secrets in Node-RED credentials or environment variables, never in examples, docs, logs, or test fixtures.
- Do not expose BullMQ lock tokens in Node-RED messages.
- Use exact scheduler ids for repeat compatibility.
- Use a BullMQ hash-tag prefix such as `{bull}` for Redis Cluster and AWS MemoryDB.

## Tests

Use test-driven changes for behavior updates:

1. Add or update the smallest failing test.
2. Run the focused test and confirm the expected failure.
3. Implement the change.
4. Run the focused test and then `npm test`.

For editor changes, run:

```sh
npm run test:playwright
```

For Redis deployment changes, run the Docker deployment matrix when available:

```sh
npm run test:deployments
```

MemoryDB tests are opt-in and must read credentials only from environment variables.

## Documentation

Update README, Node-RED help text, and the docs in `docs/` whenever public behavior changes.
