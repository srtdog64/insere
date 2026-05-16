# Insere Framework Layer

The framework layer sits above the direct core and generator/effect runtime.
It is the recommended shape for large hosts such as editors, renderers, and
game tools.

This layer still exposes a host-cooperative scheduler, not a standalone
executor. Host applications own rendering, I/O, threads, lifecycle, and the
clock. Insere provides keyed scheduling, cancellation, event ingress,
supervision, and logging around that host loop.

```txt
host app
  InsereHostAdapter
    InsereApi
      DirectInsereTask
      Insere
    InsereMailbox
    supervision policy
    structured logging
```

The direct core stays optimized for keyed restart, frame continuation, and
group cancellation. The framework layer adds host-scale concerns that should be
explicit rather than hidden in the core scheduler.

## Host Adapter

```ts
import { createInsereHostAdapter, dispatch } from "@exornea/insere";

const host = createInsereHostAdapter({
  dispatch: (event) => editor.dispatch(event),
  mailbox: { buffer: "bounded", capacity: 256 },
  supervision: {
    policy: "dispatchAndStop",
    toEvent: (failure) => ({ type: "taskFailed", failure })
  }
});

host.api.applyDirectResult("preview:drag", (ctx) => {
  ctx.dispatch({ type: "previewFrame", dt: ctx.delta });
}, "restart", "frame");

host.api.applyEffectResult("input:pointerup", function* (ctx) {
  const event = yield* host.waitEvent(
    (item) => item.type === "pointerup"
  )(ctx);
  yield* dispatch({ type: "commitDrag", event })(ctx);
});

host.emit({ type: "pointerup" });
host.tick(performance.now());
```

The host owns the clock. `tick(now)` advances both direct tasks and effect
routines. `delta` is exposed through the direct clock and host adapter for hot
paths that need frame time.

## Mailbox

`InsereMailbox` is the inbound event layer. It supports explicit buffering:

- `drop`: discard unmatched events
- `latest`: keep only the latest unmatched event
- `queue`: keep all unmatched events
- `bounded`: keep up to `capacity`, then apply `overflow`

Overflow policies:

- `drop-oldest`
- `drop-newest`
- `throw`

Waiting effects are cancellable through the task `AbortSignal`. Cancelling the
task removes the mailbox waiter.

`emit()` broadcasts an event to every matching waiter. Use it for broad host
events that multiple routines may observe, such as pointer, animation, or
collaboration events. `emitOne()` consumes only the first matching waiter and
leaves the rest active. Use it for queue-like handoff where one routine should
own the event:

```ts
mailbox.emitOne({ type: "job", id: "import:tree" });
```

The host adapter mirrors both mailbox paths:

```ts
host.emit({ type: "pointermove", x: 10 });
host.emitOne({ type: "queuedImport", assetId: "tree" });
```

Use `InsereEventBus` when inbound events have a stable target key, such as
`entity:{id}` or `script:{id}`. It indexes listeners and waiters by key and
avoids scanning every predicate waiter for targeted script events:

```ts
host.api.applyEffectResult("entity:42:script:event", function* (ctx) {
  const event = yield* host.waitBusEvent("entity:42")(ctx);
  ctx.dispatch({ type: "scriptEvent", event });
});

host.emitTo("entity:42", { type: "damage", amount: 10 });
```

For hot continuous script events, use direct subscriptions instead of Promise
waits:

```ts
host.api.applyDirectResult("entity:42:script:events", (ctx) => {
  const unsubscribe = host.eventBus.subscribe(
    "entity:42",
    (event) => runScript(event),
    { signal: ctx.signal }
  );

  ctx.onCancel(unsubscribe);
  ctx.waitFrame();
});

host.notifyTo("entity:42", { type: "damage", amount: 10 });
```

Use mailbox predicates for broad host events. Use event bus keys for targeted
script/entity events. Use `waitBusEvent()` only when the task should suspend
until the next matching event.

Use `waitUniqueBusEvent()` / `emitUniqueTo()` when the host contract guarantees
at most one suspended waiter for a key. This is the dedicated unique-key path:
it does not deliver listeners, does not buffer, and does not support multiple
waiters for the same key. Duplicate `waitUnique` registration rejects rather
than replacing the first waiter.

`emitTo()` is the full event-bus path: it delivers listeners, resumes keyed
waiters, and applies buffering when nobody receives the event. `publishTo()` is
the listener-only path when callers need a delivered count. `notifyTo()` is the
fire-and-forget hot path: it delivers subscriptions and never touches waiters,
buffers, or delivered-count bookkeeping.

Event-bus listeners are host callbacks. Listener exceptions are not swallowed:
`emitTo()`, `publishTo()`, and `notifyTo()` let them bubble to the host. Put
fallible work inside an Insere task when it should use supervision.

## Frame Loops

Use `frameLoop()` for Geukbit-style gameplay, animation, or projection phases
where one system owns many entities. The loop starts on the next host tick.
Return `true` to continue on the next frame and `false` to stop.

```ts
host.api.frameLoopResult("gameplay:systems", (ctx) => {
  for (const entity of activeEntities) {
    runGameplay(entity, ctx.delta);
  }

  return scene.isRunning;
});
```

Avoid creating one direct task per entity for gameplay or physics ticks. Keep
numeric and component loops in plain TypeScript inside one system task, then use
Insere for the lifecycle boundary: start, restart, cancel, and supervision.

## Supervision

Task application policy and supervision policy are separate.

Task policy decides how work starts:

- `spawn`
- `restart`
- `skip`

Supervision decides what happens after uncaught failure:

- `bubble`: rethrow the original failure
- `logAndStop`: log/report and keep the failed task stopped; this is the
  default isolation policy
- `dispatchAndStop`: convert failure to a host event
- `convertToResult`: send a failed Result carrying `InsereFailure` to
  `onResult`
- `restart`: restart a remembered task up to `maxRestarts`

When a task fails during `tick()` or `runIdle()`, the lower runtime catches the
failure, removes the failed task, and reports `InsereFailure` to the API
facade. The facade applies supervision and returns a failed Result unless an
explicit `bubble` policy rethrows. One failed task should not prevent unrelated
runnable tasks from advancing in the same host step.

Host-provided supervision callbacks are also isolated under non-`bubble`
policies. If `toEvent`, host dispatch, or `onResult` throws while handling a
task failure, Insere logs that callback failure as a bug and preserves the
original task failure Result.

Bounded restart only applies to tasks started through the API facade, because
the facade remembers their source callback/effect. Escape hatches such as
`api.direct.restart()` bypass this ownership model.

## AbortSignal I/O Convention

Use `abortable()` when bridging I/O APIs that accept `AbortSignal`:

```ts
const loadAsset = abortable((signal) =>
  fetch(url, { signal }).then((response) => response.arrayBuffer())
);

api.applyEffectResult("asset:load:tree", loadAsset, "restart");
```

For APIs that do not accept `AbortSignal`, keep the task key guarded by
`restart` and check cancellation before dispatching the result:

```ts
const loadLegacy = asyncEffect(async (ctx) => {
  const result = await legacyLoad();
  ctx.throwIfCancelled();
  return result;
});
```

Expected domain failures should be modeled with `attempt`, `recover`, or host
events. Uncaught exceptions are treated as bugs by logging and supervision.
