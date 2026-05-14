# Insere Framework Layer

The framework layer sits above the direct core and generator/effect runtime.
It is the recommended shape for large hosts such as editors, renderers, and
game tools.

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

host.api.waitFrame("preview:drag", (ctx) => {
  ctx.dispatch({ type: "previewFrame", dt: ctx.delta });
});

host.api.applyEffect("input:pointerup", function* (ctx) {
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

Use `InsereEventBus` when inbound events have a stable target key, such as
`entity:{id}` or `script:{id}`. It indexes waiters by key and avoids scanning
every predicate waiter for targeted script events:

```ts
host.api.applyEffect("entity:42:script:event", function* (ctx) {
  const event = yield* host.waitBusEvent("entity:42")(ctx);
  ctx.dispatch({ type: "scriptEvent", event });
});

host.emitTo("entity:42", { type: "damage", amount: 10 });
```

Use mailbox predicates for broad host events. Use event bus keys for targeted
script/entity events.

## Supervision

Task application policy and supervision policy are separate.

Task policy decides how work starts:

- `spawn`
- `restart`
- `skip`

Supervision decides what happens after uncaught failure:

- `bubble`: rethrow the original failure
- `logAndStop`: log/report and keep the failed task stopped
- `dispatchAndStop`: convert failure to a host event
- `convertToResult`: send `err(failure)` to `onResult`
- `restart`: restart a remembered task up to `maxRestarts`

Bounded restart only applies to tasks started through the API facade, because
the facade remembers their source callback/effect. Escape hatches such as
`api.direct.restart()` bypass this ownership model.

## AbortSignal I/O Convention

Use `abortable()` when bridging I/O APIs that accept `AbortSignal`:

```ts
const loadAsset = abortable((signal) =>
  fetch(url, { signal }).then((response) => response.arrayBuffer())
);

api.applyEffect("asset:load:tree", loadAsset, "restart");
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
