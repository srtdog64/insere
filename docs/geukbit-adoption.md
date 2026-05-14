# Geukbit Adoption Gate

This is the minimum bar before using Insere as a Geukbit host runtime layer.
The goal is not to make Insere own Geukbit; the goal is to make Geukbit's
task orchestration explicit, observable, cancellable, and benchmarked.

## Ready Surface

Geukbit can use the framework layer for:

- projection rebuild supersession
- asset preview restart
- viewport drag frame continuation
- autosave/build/export slots
- scene switch cancellation
- inbound editor events through mailbox
- task failure reporting through supervision
- abortable asset/import I/O

Recommended entry point:

```ts
import { createInsereHostAdapter } from "@exornea/insere";

export const tasks = createInsereHostAdapter({
  dispatch: (event) => geukbit.dispatch(event),
  getState: () => geukbit.state,
  mailbox: {
    buffer: "bounded",
    capacity: 512,
    overflow: "drop-oldest"
  },
  supervision: {
    policy: "dispatchAndStop",
    toEvent: (failure) => ({
      type: "taskFailed",
      key: failure.key,
      operation: failure.operation,
      cause: failure.cause
    })
  }
});
```

## Key Convention

Use colon-delimited keys so `cancelGroup()` can use the prefix index:

```txt
projection:scene:{sceneId}
asset:preview:{assetId}
asset:import:{assetId}
editor:drag:{pointerId}
editor:autosave:{documentId}
entity:{entityId}:script:{scriptId}
```

Rules:

- `restart` for superseded visual/editor work.
- `spawn` for unique ownership where duplicates are bugs.
- `skip` for autosave/build/export jobs that must not overlap.
- `cancelGroup("asset:")` on scene/project switch.
- `cancelGroup("entity:{id}:")` on entity deletion.

## Event Ingress

Use mailbox for inbound host events that tasks must wait on:

```ts
tasks.api.applyEffect("editor:drag:release", function* (ctx) {
  const event = yield* tasks.waitEvent(
    (item) => item.type === "pointerup"
  )(ctx);
  ctx.throwIfCancelled();
  ctx.dispatch({ type: "dragCommitted", event });
});

tasks.emit({ type: "pointerup", pointerId });
```

Use `bounded` buffering for editor input streams. Use `latest` only for state
streams where older events are always obsolete.

## Failure Policy

Use `dispatchAndStop` by default in Geukbit integration builds. This keeps task
bugs visible without hiding them behind automatic retry.

Use bounded `restart` only for tasks known to be idempotent:

- preview refresh
- transient cache warmup
- non-mutating projection read

Do not use restart supervision for:

- file writes
- network mutations
- import/export side effects
- collaborative session commits

## I/O Convention

For APIs that accept `AbortSignal`:

```ts
const load = abortable((signal) =>
  fetch(url, { signal }).then((response) => response.arrayBuffer())
);

tasks.api.applyEffect(`asset:import:${assetId}`, load, "restart");
```

For APIs that do not accept `AbortSignal`, check cancellation before dispatch:

```ts
const loadLegacy = asyncEffect(async (ctx) => {
  const result = await legacyLoad();
  ctx.throwIfCancelled();
  return result;
});
```

## Verification Before First Dogfood

Run these in Insere before wiring Geukbit:

```sh
npm run check
npm run benchmark
npm run verify:geukbit
```

Current gate:

- export smoke must import root, `./api`, `./host`, `./mailbox`, and
  `./supervision`
- all framework tests must pass
- direct restart/frame/cancelGroup benchmarks must remain faster than the
  Promise baselines
- Geukbit scale stress must pass for lifecycle, script event bus, gameplay
  continuations, physics host task, and projection restart

## Current Scale Result

Measured on 2026-05-14 with Node `v22.17.0`:

| Surface | Result | Decision |
| --- | ---: | --- |
| per-entity lifecycle cancel | Insere 8.07x faster | good fit for `cancelGroup("entity:")` |
| script event bus targeted waits | InsereEventBus 2.12x slower | use only when cancellable effect waits are needed |
| script event bus direct callbacks | InsereEventBus 1.2x slower | preferred hot script-event path |
| gameplay tick as per-entity tasks | Insere 4.38x slower | do not schedule every entity as a task |
| physics/animation hot loop in one host task | Insere 1.07x faster in this run | keep inner loop plain TS inside one task |
| runtime projection restart | Insere 5.98x faster | good fit for latest-only projection rebuilds |

The important line is gameplay/physics: Insere should own the orchestration
slot, not the inner entity iteration. Use one task per gameplay system, physics
system, animation system, or projection job; keep the per-entity numeric loop
in plain TypeScript arrays or engine data structures.

For script events, use `host.eventBus.subscribe()` for hot continuous event
delivery and `host.waitBusEvent()` only when a task must suspend until one
specific event.

## First Dogfood Slice

Start with one narrow Geukbit subsystem:

1. `projection:scene:{sceneId}` rebuild restart
2. `editor:drag:{pointerId}` frame continuation
3. `asset:preview:{assetId}` restart/cancel
4. one mailbox wait for `pointerup`
5. one abortable loader

After that, add entity lifecycle cancellation and a keyed script event bus.
Do not start with collaborative sessions. Those should come after the first
subsystem proves key ownership, failure reporting, and cancellation behavior
inside the real host.
