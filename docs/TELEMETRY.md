# Telemetry Guide

## What It Gives You

OpenTelemetry traces for producer, consumer, and internal BullMQ operations (`add`, `process`, `addFlow`, and similar) on Queue, Worker, and FlowProducer. Span names follow `{operation} {destination}`, where destination is normally the queue name (for example `process myQueue`, `addFlow myQueue`) but includes the job name for `add` (`add myQueue.myJobName`). Metrics are optional and separately switched.

Telemetry is off by default. With the master switch off, the word `telemetry` never reaches a BullMQ constructor and `bullmq-otel` is never required.

## Config Fields

`bull-queue-server` has three telemetry fields:

- `telemetry` (boolean, default `false`): master switch.
- `telemetryServiceName` (string, default `""`): used as both the tracer name and the meter name; falls back to the queue name when blank.
- `telemetryMetrics` (boolean, default `false`): sets `enableMetrics` on the telemetry client.

One telemetry client is built per config node; the Queue, Worker, and FlowProducer backed by that config node share it.

## Installation

`bullmq-otel` is an optional peer dependency, pinned to `>=2.0.0`. It is not installed automatically. Install it alongside Node-RED:

```sh
npm install bullmq-otel
```

If `telemetry` is enabled and `bullmq-otel` cannot be required, the node reports one `node.error` naming `npm install bullmq-otel` and keeps running untraced; jobs keep flowing either way.

## Host Requirements

This package does not own the OpenTelemetry SDK or an exporter. The host process registers the `TracerProvider` (and, for metrics, the `MeterProvider`) — for example via `NODE_OPTIONS` auto-instrumentation, or SDK setup in Node-RED's `settings.js`.

With nothing registered, the OpenTelemetry API no-ops. An enabled toggle without a configured host is harmless but exports nothing.

## Metrics

`telemetryMetrics` requires a `MeterProvider` registered _before_ the queue is first used — BullMQ reads it at telemetry-client construction time.

BullMQ emits:

- Counters, one per job state transition: `bullmq.jobs.completed`, `bullmq.jobs.failed`, `bullmq.jobs.delayed`, `bullmq.jobs.retried`, `bullmq.jobs.waiting`, `bullmq.jobs.waiting_children`. Attributes: `bullmq.queue.name`, `bullmq.job.name`, `bullmq.job.state`.
- Histogram `bullmq.job.duration` (milliseconds), recorded alongside the counter above whenever the job has a `processedOn` timestamp. Same attributes.
- Gauge `bullmq.queue.jobs`, the job count per state. Attributes: `bullmq.queue.name`, `bullmq.queue.jobs.state`. BullMQ only records this gauge when something calls `queue.recordJobCountsMetric()`; this package does not call it on a timer, so the gauge stays empty unless a host script invokes that method directly.

## `bull events` Is Not Traced

BullMQ 6.2.1 types `QueueEventsOptions` as `Omit<QueueBaseOptions, 'telemetry'>`. `QueueEvents` accepts no telemetry client at all, so `bull events` never emits spans or metrics regardless of the config-node toggles.

## Zero-Dependency Alternative

`msg.cmd` `exportPrometheusMetrics` (see `docs/COMMANDS.md`) needs no OpenTelemetry stack. Install nothing extra if Prometheus scraping is all you want.

## Security

Never put a secret in `telemetryServiceName` — it appears as an attribute on every span and every metric this package emits.
