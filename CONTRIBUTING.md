# Contributing

## Development Setup

Use Node.js 22.9 or newer, the floor for both the published package and Node-RED 5, and install from the lockfile:

```sh
npm ci
```

## Before Opening A Pull Request

```sh
npm test && npm run format:check
```

Both gate CI. Editor changes also need `npm run test:playwright`; Redis deployment changes also need `npm run test:deployments`. See [docs/TESTING.md](docs/TESTING.md) for what each suite covers and how to run the opt-in MemoryDB path.

## Rules And Workflow

- [docs/RULES.md](docs/RULES.md) — constraints that must not be broken: BullMQ v6 node types, pinned dependencies, secret handling, scheduler ids, cluster prefixes.
- [docs/CHANGE_WORKFLOW.md](docs/CHANGE_WORKFLOW.md) — the test-first loop, and what to update for connection, scheduler, and editor changes.
- [docs/REFERENCE_MAP.md](docs/REFERENCE_MAP.md) — which source file and which test own a given behavior.

Update the README, the Node-RED help text in `bull-queue.html`, and the relevant file in `docs/` whenever public behavior changes.
