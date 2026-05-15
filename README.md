# Insere

Host-cooperative task runtime for frame-aware TypeScript apps.

Insere is not a Promise replacement, worker pool, or general job queue. It is a
small host-cooperative task runtime for keyed, cancellable, explicitly
scheduled work that should run with an editor, game, or renderer clock.

```txt
inserere = in + serere
to insert, weave in, thread into place
```

## Install

```sh
npm install @exornea/insere
```

Use Insere when work has a named slot and a newer run should supersede the old
one:

```ts
import { Insere, delay, frame } from "@exornea/insere";

const insere = new Insere();

insere.restart("drag", function* (ctx) {
  while (true) {
    yield frame();
    ctx.dispatch({ type: "dragFrame" });
  }
});

insere.restart("projection", function* (ctx) {
  yield delay(16);
  ctx.throwIfCancelled();
  ctx.dispatch({ type: "projectionReady" });
});

insere.tick(performance.now());
```

The same work can be described through the effect/task layers when composition
matters more than writing a routine inline:

```ts
import {
  Insere,
  dispatch,
  restartTask,
  sequence,
  sleep,
  task
} from "@exornea/insere";

const insere = new Insere();

restartTask(
  insere,
  task(
    "projection",
    sequence([sleep(16), dispatch({ type: "projectionReady" })])
  )
);
```

For hot orchestration paths that should avoid both Promise and generator
overhead, use the direct core:

```ts
import {
  createInsereApi
} from "@exornea/insere/api";

const api = createInsereApi();
const editor = api.scope("editor");

api.restartDirect("projection:scene", (ctx) => {
  if (ctx.frame === 0) {
    ctx.waitFrame();
    return;
  }

  // rebuild projection; task completes unless it waits again
});

api.waitFrame("drag:preview", () => {
  // update preview on the next host tick
});

api.frameLoop("gameplay:systems", (ctx) => {
  // run one system-level frame loop; return false to stop
  return scene.isRunning;
});

editor.applyDirect("autosave", () => {
  // flush autosave once; skip policy avoids overlapping saves
}, "skip", "frame");

api.tick(performance.now());
```

Large hosts can start from the host adapter when they need one clock, one key
space, inbound events, keyed event channels, logging, and supervision:

```ts
import { createInsereHostAdapter, dispatch } from "@exornea/insere";

type HostEvent =
  | { type: "pointerup"; x: number; y: number }
  | { type: "damage"; amount: number };

type AppEvent =
  | { type: "commitPointer"; event: HostEvent }
  | { type: "taskFailed"; failure: unknown };

const host = createInsereHostAdapter<unknown, AppEvent, HostEvent>({
  dispatch: (event) => console.log(event),
  mailbox: { buffer: "bounded", capacity: 256 },
  supervision: {
    policy: "dispatchAndStop",
    toEvent: (failure) => ({ type: "taskFailed", failure })
  }
});

host.api.applyEffect("input:pointerup", function* (ctx) {
  const event = yield* host.waitEvent(
    (item) => item.type === "pointerup"
  )(ctx);
  yield* dispatch<AppEvent>({ type: "commitPointer", event })(ctx);
});

host.api.applyDirect("entity:42:events", (ctx) => {
  const unsubscribe = host.subscribeTo(
    "entity:42",
    (event) => console.log("entity event", event),
    { signal: ctx.signal }
  );

  ctx.onCancel(unsubscribe);
  ctx.waitFrame();
});

host.emit({ type: "pointerup", x: 12, y: 20 });
host.notifyTo("entity:42", { type: "damage", amount: 3 });
host.tick(performance.now());
```

## Model

Insere is a task runtime, not a standalone executor. It never owns threads,
CPU parallelism, I/O execution, or background work. The host owns the clock and
calls `tick(now)`; Insere only advances work that has explicitly yielded back
to that host clock.

- A direct task is a keyed callback over the host clock.
- A routine is a generator.
- A routine yields scheduling instructions.
- An effect is a composable generator program over the same instructions.
- A task is a keyed effect declaration that can be spawned, restarted, or
  cancelled.
- The host owns the clock and calls `tick(now)`.
- Cancellation is explicit through an `AbortSignal`.
- `restart(key, routine)` aborts the previous routine in the same key slot.
- Promise support exists only as an I/O bridge, not as the default execution
  model.

Effect helpers cover the small composition surface:

- values and sync work: `succeed`, `sync`, `fail`, `ok`, `err`, `isOk`,
  `isErr`, `matchResult`
- host interaction: `dispatch`, `getState`, `access`, `currentFrame`,
  `currentKey`, `currentTime`, `currentDelta`, `checkCancellation`, `onCancel`
- scheduling: `sleep`, `sleepUntil`, `waitFrame`, `waitFrames`, `waitIdle`,
  `awaitPromise`, `asyncEffect`
- I/O bridge: `abortable` for `AbortSignal`-aware Promise APIs
- composition: `map`, `flatMap`, `tap`, `attempt`, `recover`, `ensuring`,
  `acquireUseRelease`, `when`, `unless`, `repeat`, `forEach`, `whileEffect`,
  `sequence`
- runtime adaptation: `toRoutine`
- task policy: `applyTask` with `spawn`, `restart`, or `skip`;
  `applyTaskResult` returns an `InsereResult` policy report
- direct core: `DirectInsereTask` / `InsereCore` with `spawn`, `restart`,
  `waitFrame`, `frameLoop`, `cancelGroup`, and lazy `AbortSignal`
- direct task policy and scopes: `directTask`, `directFrameTask`,
  `applyDirectTask`, `applyDirectTaskResult`, and `DirectInsereTaskScope`
- facade API: `createInsereApi`, `InsereApi`, and `InsereApiScope` from
  `@exornea/insere/api`
- structured host logging: `logger`, `createConsoleInsereLogger`, and
  `createBufferedInsereLogger` for bug records at the API boundary; disabled
  logging is a fast no-op and does not read `requestId`
- framework layer: `createInsereHostAdapter`, `InsereMailbox`, `waitEvent`,
  `InsereEventBus`, `waitBusEvent`, listener-only `publish`/`notify`, and
  explicit supervision policy for large host applications

Runtime state stays observable without taking ownership away from the host:
`size`, `frame`, `now`, `has(key)`, `keys()`, and `snapshot()` report the
scheduler state.

## Fit

Good fits:

- editor interaction flows
- drag/session loops
- frame-aware simulation steps
- debounced projection rebuilds
- renderer-side async boundaries

Poor fits:

- replacing `async` / `await`
- pretending to be a standalone executor
- CPU parallelism
- worker pools
- general job queues
- invisible background magic

## Status

Version `0.1.0` is a public pre-release. The core scheduler, API facade,
logging, supervision, mailbox, and benchmark gates are usable, but the API
should still be treated as experimental until real host dogfood stabilizes it.

See [`docs/todo.md`](docs/todo.md) for the current design status. Event
mailbox, failure supervision, host adapter guidance, and benchmark gates are
implemented; entity lifecycle composition remains a recipe-level design item.

See [`docs/api.md`](docs/api.md) for the host-facing facade design.

See [`docs/logging.md`](docs/logging.md) for structured bug logging.
It covers `requestId` propagation and the no-logger fast path.

See [`docs/framework.md`](docs/framework.md) for mailbox, supervision, host
adapter, and AbortSignal I/O conventions.

See [`docs/performance.md`](docs/performance.md) for the current benchmark
against plain TypeScript/JavaScript baselines.

See [`docs/stability.md`](docs/stability.md) for the package boundary, public
entrypoints, and release gates.

Run `npm run check` for the standard build, test typecheck, test,
export-smoke, and pack gate.
Run `npm run verify:geukbit` for the Geukbit scale stress and benchmark gate,
or `npm run check:release` before cutting a release candidate.
