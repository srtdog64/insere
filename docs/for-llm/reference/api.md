# Insere API Design

`@exornea/insere/api` is the recommended host-facing entry point.

The root package still exports the lower-level building blocks, but application
adapters should usually start from the API facade:

```ts
import { createInsereApi } from "@exornea/insere";
import { createInsereApi as createApi } from "@exornea/insere/api";
```

The API facade is a scheduler facade, not an executor facade. It gives a host
one key space, one clock, policy Result reports, and supervision hooks over the
direct and effect schedulers. It does not run work outside the host tick.

```ts
import { createInsereApi } from "@exornea/insere/api";

const api = createInsereApi({ dispatch, getState });
const editor = api.scope("editor");

editor.applyDirect("preview", updatePreview, "restart", "frame");
editor.applyEffectResult("autosave", autosaveEffect, "skip");

api.tick(performance.now());
```

Hosts can attach request/session trace ids to bug logs without using global
context:

```ts
const api = createInsereApi({
  dispatch,
  getState,
  logger,
  requestId: () => host.currentRequestId
});
```

The provider is lazy. It is called only when a logger exists and Insere is
building a failure record. A host can leave `requestId` wired in production
without adding cost to normal successful scheduling paths.

Pass `logger` when the host wants structured bug records:

```ts
import {
  createConsoleInsereLogger,
  createInsereApi
} from "@exornea/insere/api";

const api = createInsereApi({
  logger: createConsoleInsereLogger(),
  supervision: {
    policy: "dispatchAndStop",
    toEvent: (failure) => ({ type: "taskFailed", failure })
  }
});
```

## Goals

- Keep direct tasks and generator effects on one host clock.
- Keep direct tasks and generator effects in one key space.
- Keep policy semantics identical across direct and effect work.
- Return Result reports for host adapters that should avoid policy exceptions.
- Keep hot direct paths available without forcing effect/generator overhead.

## Layers

```txt
@exornea/insere/api
  InsereApi
    direct: DirectInsereTask
    effect: Insere
  InsereApiScope
    direct: DirectInsereTaskScope
    effect: InsereTaskScope
```

`InsereApi` owns both runtimes. `tick(now)` advances direct tasks first, then
effect routines. `runIdle()` pumps both idle queues. `cancel`, `cancelGroup`,
and `cancelAll` apply to both runtimes.

`InsereApiScope` builds prefixed keys and returns filtered snapshots across
both runtimes.

`api.direct`, `api.effect`, `scope.direct`, and `scope.effect` are exposed as
escape hatches. Calling them directly bypasses the facade's shared-key policy.
Host adapters that need one logical key space should use `InsereApi` and
`InsereApiScope` methods for task application and cancellation.

## Policy

Policy meanings are shared:

- `restart`: supersede existing work at the same key.
- `spawn`: start only when the key is free; duplicate keys become `err(error)`
  in Result APIs and throw in boolean APIs.
- `skip`: start only when the key is free; active keys return
  `ok({ applied: false, status: "skipped" })`.

Boolean methods exist for ergonomic command paths:

```ts
api.applyDirect("drag:preview", step, "restart", "frame");
api.frameLoop("gameplay:systems", step, "restart");
api.applyEffect("autosave", effect, "skip");
```

Result methods exist for host adapters:

```ts
const result = api.applyDirectResult("autosave", step, "skip", "frame");
```

`tick(now)` and `runIdle()` also return `InsereResult<void>` from the API
facade and host adapter. With the default `bubble` supervision they still
rethrow uncaught task failures after logging. Use `logAndStop`,
`dispatchAndStop`, or `convertToResult` when the host wants non-throwing
runtime failure handling.

See [`throw-boundaries.md`](throw-boundaries.md) for the exact Result and
intentional throw boundaries.

When a logger is installed, duplicate `spawn`, invalid task specs, uncaught
task failures, and cancellation failures also emit `kind: "bug"` records.
`skip` and normal `restart` decisions do not log.

See [`logging.md`](logging.md) for the full record shape, bug logging contract,
and zero-work disabled logging behavior.

Supervision is separate from task policy. Task policy controls how work starts;
supervision controls what happens after uncaught failure. The API facade
supports `bubble`, `logAndStop`, `dispatchAndStop`, `convertToResult`, and
bounded `restart`. See [`framework.md`](framework.md) for the larger host
adapter model.

The Result value shape is shared:

```ts
type InsereTaskApplyResult = InsereResult<{
  key: string;
  policy: "spawn" | "restart" | "skip";
  applied: boolean;
  status: "started" | "restarted" | "skipped";
}>;
```

`InsereResult` errors are structured `AppError` values:

```ts
type AppError = {
  code: ErrorCode;
  message: string;
  stage: Stage;
  retryable?: boolean;
  cause?: unknown;
  meta?: Readonly<Record<string, unknown>>;
};
```

Use `appError()` or `toAppError()` when host adapters convert external
exceptions into Result values. `String(error)` returns the error message for
ergonomic logging, while `code`, `stage`, and `meta` stay available for policy.

## Choosing Direct vs Effect

Use direct work for hot orchestration:

- projection rebuild supersession
- drag preview frame continuation
- autosave slots
- asset preview restart
- scene-switch cancellation

Use effect work for expressive composition:

- Promise bridges
- `attempt` / `recover`
- resource lifecycle helpers
- sequential workflows
- reusable effect declarations

The facade keeps both available without forcing one model into the other.
