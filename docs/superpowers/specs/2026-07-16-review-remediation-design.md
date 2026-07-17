# Review Remediation And Dependency Update Design

Date: 2026-07-16

## Objective

Address the actionable findings in `REVIEW-2026-07-16.md`, preserve the package's
legacy Node-RED contracts, and update the exact runtime dependency pins to:

- `bullmq` `5.80.6`
- `ioredis` `5.11.1`

The npm registry was checked on 2026-07-17. BullMQ `5.80.6` is the current
`latest` release and depends on ioredis `5.11.1`, so the direct ioredis pin keeps
one deduplicated installed copy.

## Constraints

- Keep the legacy node types `bull-queue-server`, `bull cmd`, and `bull run`.
- Do not reintroduce `bull` or `sprintf-js`.
- Keep both runtime dependencies pinned exactly, without semver ranges.
- Keep secrets in Node-RED credentials or environment variables.
- Do not expose BullMQ lock tokens in Node-RED messages.
- Keep exact scheduler-id matching and the Cluster/MemoryDB hash-tag prefix rule.
- Use test-driven development for every behavior change.
- Do not rewrite historical specs or plans that accurately describe earlier releases.

## Review Disposition

### Actionable

- The `bull job` progress-to-complete help example leaves `msg.cmd = "progress"`
  on the message, so the downstream configured `complete` action is overridden.
- Partial redeploys retain the raw Redis connection for `bull run`, `bull events`,
  and `bull flow`. The original review incorrectly excluded `bull run`.
- Config-node shutdown closes independent resources sequentially, making the
  worst-case timeout grow with the resource count.
- The shared producer connection can exceed EventEmitter's default listener
  warning threshold when many `bull cmd` nodes use one config node.
- Endpoint parsing mishandles bare and URL-form IPv6 and silently discards
  credentials embedded in Redis URLs.
- A `rediss://` endpoint can currently be combined with the wrong explicit TLS
  setting and silently attempt a plaintext connection.
- A worker limiter is silently ignored when only one limiter field is configured.
- The editor should hide Ack Timeout outside manual completion mode, hide Database
  for Cluster/MemoryDB, and use a neutral queue placeholder.
- Playwright currently checks definitions and template text but does not exercise
  an open edit dialog or its row-toggling behavior.
- The confirmed documentation drift in D2-D7, D10, and D11 requires correction.
- `msg.command` and the `memorydb` deployment alias are compatibility inputs and
  should be documented. Cluster DNS passthrough applies with or without TLS.
- The plaintext secret fallback is intentional legacy compatibility. It should be
  explicitly documented as migration-only, with Node-RED credentials preferred.

### Rejected Or Deferred

- The shared Queue is not stored in `node.resources`, so the reported duplicate
  Queue close does not occur.
- Legacy `count` has counted repeatable schedulers since 2019; D8 is incorrect.
- Object-to-error formatting, invalid hand-edited persisted numeric values, label
  widths, node colors, and config-label fallback are not broken public contracts.
- Redis timeout constants are internal implementation details, not user options.
- Documentation deduplication and retry-log throttling are separate maintenance
  work and are not required for this repair.

## Runtime Design

### Resource Ownership And Partial Redeploy

Replace the mixed resource `Set` with one ownership map:

| BullMQ owner | Backing raw connection |
| --- | --- |
| shared `Queue` | producer connection |
| `Worker` | worker connection |
| `QueueEvents` | original events connection |
| `FlowProducer` | dedicated producer-role connection |

The config node will expose one release operation for runtime nodes. Releasing an
owner will:

1. remove the owner/connection pair from tracking;
2. close the BullMQ owner first;
3. close its raw connection second.

`bull run`, `bull events`, and `bull flow` close handlers will call that operation
instead of closing only their BullMQ object. This fixes the leak once at the
resource owner boundary and prevents the tracking collection from growing across
partial redeploys.

On config-node shutdown, snapshot and clear all remaining pairs, then close the
pairs concurrently. Ordering remains sequential inside each pair, while unrelated
pairs no longer consume one grace period each. The shared Queue becomes a normal
tracked pair, eliminating special-case shutdown code.

Use native Promise combinators for bounded and concurrent shutdown. Replace the
25 ms polling loop with `Promise.race`, and use `Promise.all` across independent
resource pairs. Narrow the async-style contract so it still rejects hand-built
Promises and chained `.then()`/`.catch()` code but permits these standard
combinators.

### Shared Producer Listeners

Keep the existing per-`bull cmd` status listeners because they are removed on node
close and are not a leak. Set the shared producer connection's listener limit to
unlimited with EventEmitter's native `setMaxListeners(0)`. A fan-out abstraction
would add state and lifecycle code without changing behavior.

### Endpoint Parsing

Use Node's `URL` and `node:net` support instead of extending the current regular
expression.

Accepted forms for Cluster and Sentinel endpoint lists:

- `host`
- `host:port`
- bare IPv6 such as `::1`, using the default port
- bracketed IPv6 such as `[::1]:6379`
- `redis://host:6379`
- `rediss://host:6379`

URL credentials must be rejected with a clear error. Authentication remains in
the config node's credential fields; it must never be silently extracted from or
discarded from an endpoint string.

URL schemes do not override explicit TLS settings. When a URL includes a scheme,
the scheme and the applicable setting must agree or deployment fails:

- Cluster `redis://` / `rediss://` URLs are checked against `tls`.
- Sentinel discovery `redis://` / `rediss://` URLs are checked against
  `sentinelTls`; the separate `tls` setting still controls data-node connections.

Host and `host:port` forms carry no TLS intent, so the applicable checkbox remains
the sole source of truth for those forms.

### Worker Limiter Validation

Limiter Max and Limiter Duration form one optional pair:

- both blank: no worker limiter;
- both present: each must be a positive integer;
- only one present: deployment fails with a clear paired-field error.

Apply the same rule in the editor so ordinary users see validation before deploy.
Runtime validation remains necessary for imported or hand-edited flows.

### Dependency Update

Update the exact package and lockfile pins, `test/package-contract.test.js`,
`test/docs-contract.test.js`, `CLAUDE.md` (and therefore its `AGENTS.md` symlink),
maintained version references, runtime pin comment, release guide, contributor
instructions, README, migration guide, and changelog. Do not alter the completed
2026-07-12 design and plan, which are historical records of the earlier update.

## Editor And Help Design

- Give the Ack Timeout row a dedicated class and show it only when Completion is
  `manual`.
- Give the Database row a dedicated class and hide it only for `cluster`.
  Standalone and Sentinel continue to support a database number.
- Change the queue placeholder from `basecasts` to `email-jobs`; actual legacy
  example data remains unchanged.
- Keep `msg.cmd` precedence. Fix the help example by deleting `msg.cmd` before a
  message enters a downstream node whose configured Action should apply.
- Add editor validation for positive integer concurrency and paired positive
  limiter values.

Playwright will create real config and run nodes, open their edit dialogs, change
Deployment and Completion values, and assert the affected rows' visibility.
Static editor contract tests remain useful for field and help-text coverage.

## Documentation Corrections

- `docs/RELEASE.md`: refer to CodeQL default setup rather than a nonexistent
  workflow file.
- `docs/REFERENCE_MAP.md` and `docs/TESTING.md`: include shutdown and async-style
  tests in the inventory.
- `docs/NODE_GUIDE.md`: list the 16 default QueueEvents events.
- `docs/CONNECTIONS.md`: say unauthorized certificates are rejected by default,
  document endpoint formats and credential rejection, document `memorydb` as a
  compatibility alias, clarify unconditional cluster DNS passthrough, and warn
  that plaintext secret fields are migration-only.
- `README.md` and `docs/TESTING.md`: replace internal “required basecasts” wording
  with user-facing legacy scheduler compatibility language.
- `docs/TROUBLESHOOTING.md`: remove `msg.jobopts.jobId` from scheduler lookup IDs;
  it remains valid only when creating a scheduled job.
- `README.md`: mention all three shipped example flow files.
- `docs/ARCHITECTURE.md`: state that `bull cmd` mirrors its shared producer
  connection while runtime nodes report their own connections.
- `docs/COMMANDS.md` and `docs/NODE_GUIDE.md`: document `msg.command` as a legacy
  alias while continuing to recommend `msg.cmd`.
- `CHANGELOG.md`: identify URL-credential rejection as a compatibility change and
  tell users to move credentials into the config node's credential fields.

## Error Handling

- Resource release remains best-effort under unreachable Redis, bounded by the
  existing one-second grace period before force-disconnect.
- Concurrent config shutdown reports a close error through Node-RED's `done(err)`
  while all already-started close operations continue.
- Endpoint URLs containing a username or password fail before a Redis connection
  is created.
- An explicit endpoint URL scheme that contradicts the applicable Cluster or
  Sentinel TLS setting fails before a Redis connection is created.
- Incomplete or invalid limiter configuration fails with field-specific text.

## Test Strategy

Follow red-green TDD with the smallest focused test for each behavior:

1. Package tests fail until BullMQ `5.80.6` and ioredis `5.11.1` are pinned and
   deduplicated.
2. Shutdown tests prove partial close removes both tracked resources and stops
   reconnection for `bull run`, `bull events`, and `bull flow`.
3. A deterministic fake-resource test proves independent config resources begin
   closing concurrently.
4. Registration tests directly assert the shared producer connection has an
   unlimited listener cap and that every `bull cmd` listener is removed on close;
   no process-global warning capture is needed.
5. Connection tests cover hostname, bracketed and bare IPv6, credential-free URLs,
   rejection of URL credentials, and topology-specific URL-scheme/TLS mismatches.
6. Runtime and editor tests cover blank, complete, incomplete, non-integer, zero,
   and negative limiter configurations.
7. Editor contract and Playwright tests cover the corrected help example,
   placeholder, and live row visibility.
8. Documentation contract tests pin the corrected security and inventory wording.

Mandatory final verification:

```sh
npm test
npm run test:playwright
npm run test:integration
npm run test:deployments
npm run format:check
npm run validate
npm audit --omit=dev --audit-level=moderate
git diff --check
```

MemoryDB remains opt-in and uses environment variables only.
