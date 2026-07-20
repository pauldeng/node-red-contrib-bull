# Agent Guide

This repository is a Node-RED node package that migrated from Bull v4 to BullMQ 5.80.9.

## Start Here

Read these files before changing behavior:

- `GOAL.md` for the active user objective when present.
- `docs/REFERENCE_MAP.md` for where behavior is documented.
- `docs/ARCHITECTURE.md` for runtime boundaries.
- `docs/NODE_GUIDE.md` for public node contracts.
- `docs/COMMANDS.md` for `msg.cmd` behavior.
- `docs/CONNECTIONS.md` before touching Redis options.
- `docs/TESTING.md` before claiming completion.

## Engineering Rules

- Use test-driven development for behavior changes.
- Keep legacy node types: `bull-queue-server`, `bull cmd`, and `bull run`.
- Do not reintroduce `bull` or `sprintf-js`.
- Keep BullMQ pinned to exactly `5.80.9`.
- Keep secrets in Node-RED credentials or environment variables, never in examples/docs/logs.
- Do not expose BullMQ lock tokens in Node-RED messages.
- Use exact scheduler ids for repeat compatibility; never substring-match scheduler keys.
- Cluster and AWS MemoryDB configs need a BullMQ hash-tag prefix such as `{bull}`.

## Verification

At minimum run:

```sh
npm test
```

For editor changes, add/run Playwright coverage. For deployment changes, run the relevant Docker topology suite when available. MemoryDB tests are opt-in and must read credentials only from environment variables.
