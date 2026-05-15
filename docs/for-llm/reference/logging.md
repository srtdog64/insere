# Insere Logging

Insere logging is host-owned. The runtime emits structured records only when a
host passes a `logger` to the API facade:

```ts
import {
  createConsoleInsereLogger,
  createInsereApi
} from "@exornea/insere/api";

const api = createInsereApi({
  logger: createConsoleInsereLogger(),
  requestId: () => editor.currentRequestId
});
```

Logging does not change scheduling, cancellation, retry, or failure behavior.
It is observation only. If a task throws, Insere logs the bug record and the
API facade returns a failed Result under the default isolation policy. If a
Result API returns `err(error)`, Insere logs the bug record and still returns
the same Result shape.

## Performance Contract

Logging is designed to be opt-in and cold-path only:

- no `logger`: API-boundary logging returns before reading `requestId`
- no `logger`: Insere does not build log records
- no `logger`: Insere does not allocate log `data` objects
- logger installed: records are built only for bug/failure paths
- logger installed: `requestId` providers are read only while building a record
- logger failure: swallowed so logging never hides the runtime failure Result

Do not use logging for per-frame tracing or normal task lifecycle telemetry.
If a host needs high-volume traces, emit those from the host with its own
sampling/buffering policy. Insere's built-in logging is for bugs and failure
diagnostics.

## Record Shape

```ts
interface InsereLogRecord {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  kind: "bug" | "runtime" | "policy";
  runtime: "api" | "direct" | "effect";
  stage: string;
  event: string;
  requestId?: string;
  operation: string;
  message: string;
  key?: string;
  policy?: string;
  frame?: number;
  now?: number;
  delta?: number;
  cause?: unknown;
  data?: Readonly<Record<string, unknown>>;
}
```

The current API facade emits `kind: "bug"` records for conditions that usually
mean the host adapter or task body has a defect:

- duplicate `spawn` across the shared direct/effect key space
- invalid task specs, such as an empty key
- uncaught task failures during `tick()` or `runIdle()`
- failures while cancelling, restarting, or cancelling a group
- failures inside host-provided supervision callbacks

`requestId` is optional and host-supplied. Pass a string for a stable adapter
instance id, or a function when the host has a changing request/session id.
Insere does not use global async context for request ids so the core remains
portable across browser, Node, and embedded hosts.

Recommended host pattern:

```ts
const tasks = createInsereHostAdapter({
  logger: createConsoleInsereLogger(),
  requestId: () => host.currentRequestId
});
```

Avoid global mutable context inside Insere. The host should own request/session
identity and expose it through the provider.

`skip` is not a bug. It is an expected policy decision and does not log.
`restart` is not a bug. It is the normal supersession path.

## Bug Logging Contract

A bug log should include enough host-clock context to reproduce the failure:

```txt
operation  applyDirectResult | applyEffectResult | tick | runIdle | cancel | ...
key        logical task key when available
policy     spawn | restart | skip when the failure came from task application
frame      current Insere frame
now        current Insere clock time
delta      current direct-runtime delta
cause      original thrown error or rejection reason
data       operation-specific details, for example { tickNow: 16 }
```

During `tick(now)`, a throwing task can fail before the direct runtime commits
all public clock fields. In that case the record includes the exposed runtime
state plus `data.tickNow`, which is the host time passed to the failing tick.

## Buffered Logger

Tests and editor diagnostics can use the bounded in-memory logger:

```ts
import {
  createBufferedInsereLogger,
  createInsereApi
} from "@exornea/insere/api";

const logs = createBufferedInsereLogger(200);
const api = createInsereApi({ logger: logs.logger });

for (const record of logs.records) {
  console.log(record);
}
```

The buffer drops the oldest record when it reaches the limit. A throwing logger
is ignored so logging cannot hide the runtime failure Result.

## Host Policy

Recommended host routing:

- `kind: "bug"` should go to the host's bug/error channel.
- duplicate `spawn` should be treated as a key ownership bug.
- uncaught task failure should be visible to development builds immediately.
- expected domain failures should be modeled through `attempt`,
  `InsereResult`, or host events instead of uncaught exceptions.

Logging is not failure supervision. Supervision still needs a separate policy
for `bubble`, `logAndStop`, bounded `restart`, or host event conversion.
