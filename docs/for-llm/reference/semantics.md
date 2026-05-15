# Insere Semantics

## API Facade

`@exornea/insere/api` exposes the recommended host-facing API:

```ts
import { createInsereApi } from "@exornea/insere/api";

const api = createInsereApi({ dispatch });
const editor = api.scope("editor");

editor.applyDirect("preview", updatePreview, "restart", "frame");
editor.applyEffectResult("autosave", autosaveEffect, "skip");
api.tick(performance.now());
```

The facade keeps direct callbacks and generator effects on the same host
clock, key space, cancellation surface, and Result-based policy reporting
shape. Lower-level modules remain public for custom integrations.

## Routine

A routine is a generator function:

```ts
function* routine(ctx: InsereContext) {
  yield frame();
  yield delay(100);
}
```

It runs only when the host advances the runtime.

## Effect

An effect is a composable routine fragment:

```ts
const projection = sequence([
  sleep(16),
  dispatch({ type: "projectionReady" })
]);
```

Effects are still cooperative. They only move when the runtime starts or
resumes the routine created with `toRoutine(effect)`.

Effects can inspect their scheduling context:

```ts
const mark = flatMap(currentKey(), (key) =>
  dispatch({ type: "routineStarted", key })
);
```

Frame and clock helpers are host-clock based:

```ts
const afterTwoFrames = sequence([waitFrames(2), dispatch({ type: "ready" })]);
const atTime = sequence([sleepUntil(250), dispatch({ type: "deadline" })]);
```

Promise effects resume with the fulfilled value:

```ts
const load = flatMap(awaitPromise(fetch(url)), (response) =>
  dispatch({ type: "loaded", response })
);
```

Use `asyncEffect` when Promise work should be created only after the effect
actually starts:

```ts
const load = asyncEffect((ctx) => fetch(url, { signal: ctx.signal }));
```

Failures can be made explicit with `attempt`:

```ts
const guarded = flatMap(attempt(awaitPromise(fetch(url))), (result) =>
  dispatch(result.ok ? { type: "loaded" } : { type: "failed" })
);
```

`attempt` returns an `InsereResult`. Use `ok`, `err`, `isOk`, `isErr`, and
`matchResult` when result values need to move through application code without
throwing.

Without `attempt`, a rejected Promise is thrown through the routine and removes
that routine from the runtime.

Use `recover` to continue with another effect after failure, and `ensuring` to
run an effect finalizer on normal completion or failure:

```ts
const guarded = ensuring(
  recover(load, () => dispatch({ type: "failed" })),
  dispatch({ type: "finished" })
);
```

Use `acquireUseRelease` when an effect has a resource that should be released
after successful acquisition:

```ts
const session = acquireUseRelease(openSession, runSession, closeSession);
```

Collection and loop helpers run sequentially within the same routine:

```ts
const emitAll = forEach(items, (item) => dispatch({ type: "item", item }));
const loop = whileEffect(() => dragging, sequence([waitFrame(), emitDrag]));
```

## Task

A task is a named effect declaration:

```ts
restartTask(runtime, task("projection", projection));
```

The task layer does not add hidden scheduling. It only binds an effect to a key
and forwards lifecycle operations to the runtime.

Task application policy is explicit:

```ts
applyTask(runtime, task("projection", projection, "restart"));
applyTask(runtime, task("drag", dragLoop, "spawn"));
applyTask(runtime, task("autosave", autosave, "skip"));
```

- `restart` cancels existing work at the same key and starts the new task.
- `spawn` starts only when the key is unused and otherwise lets the runtime
  duplicate-key error surface.
- `skip` starts only when the key is unused and returns `false` if work already
  exists.

Use `applyTaskResult` when host adapters should receive policy decisions as
values instead of exceptions:

```ts
const result = applyTaskResult(runtime, task("autosave", autosave, "skip"));
```

The result is `ok({ applied: false, status: "skipped" })` for a skipped task,
and `err(error)` for runtime failures such as duplicate `spawn` keys.

Use `taskKey` and `taskGroup` when multiple tasks share a cancellation prefix:

```ts
task(taskKey("projection", "preview"), projection);
runtime.cancelGroup(taskGroup("projection"));
```

Scopes can build the same keys without repeating the prefix:

```ts
const projection = new InsereTaskScope(runtime).child("projection");
projection.restart(projection.task("preview", previewEffect));
projection.restartEffect("primary", primaryEffect);
projection.cancelScope();
```

Scopes also expose filtered observation helpers:

```ts
projection.keys();
projection.snapshot();
```

## Direct Task Core

`DirectInsereTask` is the hot path for keyed work that should not pay generator
or Promise overhead:

```ts
const runtime = new DirectInsereTask();

runtime.restart("projection:scene", (ctx) => {
  if (ctx.frame === 0) {
    ctx.waitFrame();
    return;
  }

  ctx.complete();
});

runtime.waitFrame("preview:drag", () => {
  updatePreview();
});

runtime.tick(performance.now());
```

Direct tasks use callbacks instead of yielded instructions:

- `spawn` starts a unique keyed callback and throws on duplicate keys.
- `restart` supersedes the previous callback in the same key slot.
- `waitFrame(key, step)` registers a task that is already waiting for the next
  host tick.
- `frameLoop(key, step)` registers a system-level frame loop. It starts on the
  next host tick, waits for the following frame automatically when the callback
  returns `true`, and stops when the callback returns `false`.
- `ctx.waitFrame()`, `ctx.waitIdle()`, `ctx.sleep(ms)`, and
  `ctx.sleepUntil(time)` suspend the callback until a later host action.
- `ctx.complete()` marks the task complete. A direct task also completes when
  the callback returns without setting another wait.

Use direct tasks for projection rebuild supersession, drag preview ticks,
autosave slots, asset preview restarts, gameplay system loops, and scene-switch
prefix cancellation.
Use generator effects when sequential composition, `attempt`, `recover`, or
resource helpers are more important than raw scheduling cost.

Direct task specs and scopes mirror the generator task policy layer:

```ts
const editor = new DirectInsereTaskScope(runtime).child("editor");

editor.applyTask("autosave", flushAutosave, "skip", "frame");
editor.apply(editor.frameTask("preview", updatePreview, "restart"));
editor.cancelScope("preview");
```

The policy meanings are the same as effect tasks: `restart` supersedes,
`spawn` requires a free key, and `skip` returns `false` when the key is already
active.

Direct task application has the same Result form through
`applyDirectTaskResult`, `scope.applyResult`, and `scope.applyTaskResult`.
This keeps policy reporting identical between generator/effect tasks and direct
tasks.

## Framework Semantics

The framework layer adds first-class host concerns:

- `InsereMailbox` receives inbound host events.
- `waitEvent(mailbox, match)` suspends an effect until a matching event arrives.
- Cancelling the task removes its mailbox waiter.
- `mailbox.emit(event)` broadcasts to every matching waiter.
- `mailbox.emitOne(event)` consumes only the first matching waiter.
- `InsereEventBus` supports keyed inbound events through `emitTo`,
  `waitBusEvent`, `waitUniqueBusEvent`, `subscribeTo`, and listener-only
  `publishTo`.
- `waitUniqueBusEvent` / `emitUniqueTo` are a narrower contract: at most one
  suspended waiter may exist for a key, duplicate unique waits reject, and
  unique emits do not deliver listeners or buffer missed events.
- `InsereHostAdapter` combines one `InsereApi`, one mailbox, and one host
  clock.
- Supervision is explicit and separate from task application policy.

Supervision policies:

- `bubble`: explicitly rethrow the original failure after reporting.
- `logAndStop`: record the failure and leave the failed task stopped. This is
  the default isolation policy.
- `dispatchAndStop`: convert failure into a host event.
- `convertToResult`: report a failed Result carrying `InsereFailure` to the
  host.
- `restart`: restart API-owned work up to `maxRestarts`.

`restart` supervision is bounded and only works for tasks started through the
API facade, because the facade owns the callback/effect needed to recreate the
task. After the restart limit is exhausted, the failed task remains stopped and
the API returns a failed Result.

## Keyed Supersession

`restart(key, routine)` cancels the previous routine for the same key before
spawning the new one.

This makes transient editor work explicit:

```txt
projection changed -> restart("projection", rebuildProjection)
drag started       -> restart("drag", dragLoop)
drag cancelled     -> cancel("drag")
```

## Cancellation

Every routine receives an `AbortSignal`. Routines should check the signal after
long waits or before dispatching results.

```ts
ctx.throwIfCancelled();
```

Cancellation callbacks are synchronous and run when a routine is cancelled,
including replacement through `restart`:

```ts
const cleanup = onCancel((ctx) => ctx.dispatch({ type: "cancelled", key: ctx.key }));
```

## Promise Bridge

Promise waits are allowed for I/O boundaries:

```ts
yield fromPromise(fetch(url));
```

Do not use Promise waits as the default frame-loop mechanism.
