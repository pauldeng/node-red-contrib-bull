# Agent Guide

BullMQ v6 job queue nodes for Node-RED, backed by Redis or PostgreSQL. Version 2 is a breaking API with no Bull v4 or BullMQ v5 compatibility aliases.

## Before Any Change

- `docs/RULES.md` — hard constraints. Breaking one breaks a released contract or leaks a secret.
- `docs/CHANGE_WORKFLOW.md` — the test-first loop and what to update per kind of change.
- `docs/REFERENCE_MAP.md` — which source file and which test own a given behavior.
- `GOAL.md` — the active objective when present. Local and git-ignored, so it may not exist.

## Verify

```sh
npm test && npm run format:check
```

Both gate CI on every pull request, so treat them as the floor for any change. Editor changes also need Playwright, and Redis deployment changes need the Docker topology matrix — commands and coverage expectations are in `docs/TESTING.md`.

## Deeper Reference

| When you are working on                  | Read                      |
| ---------------------------------------- | ------------------------- |
| runtime boundaries, resource ownership   | `docs/ARCHITECTURE.md`    |
| public node contracts and message shapes | `docs/NODE_GUIDE.md`      |
| `msg.cmd` behavior                       | `docs/COMMANDS.md`        |
| backend choice, TLS, cluster, sentinel   | `docs/CONNECTIONS.md`     |
| OpenTelemetry tracing and metrics        | `docs/TELEMETRY.md`       |
| tests and verification                   | `docs/TESTING.md`         |
| upgrading from older package versions    | `docs/MIGRATION.md`       |
| a reported failure                       | `docs/TROUBLESHOOTING.md` |
| publishing                               | `docs/RELEASE.md`         |
