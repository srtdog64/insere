# Insere

Tiny cooperative scheduler for keyed, cancellable TypeScript editor workloads.

Insere is not a Promise replacement, worker pool, or general job queue. It is a
small host-cooperative scheduler for keyed, cancellable, explicitly scheduled
work that should run with an editor, game, or renderer clock.

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
  // run one system-level frame loop; return true to continue, false to stop
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
host.api.applyEffect("entity:42:next-hit", function* (ctx) {
  const event = yield* host.waitUniqueBusEvent("entity:42")(ctx);
  ctx.dispatch({ type: "script:hit", event });
});
host.emitUniqueTo("entity:42", { type: "damage", amount: 10 });
host.tick(performance.now());
```

## Model

Insere is a small cooperative scheduler, not a standalone executor. It never
owns threads, CPU parallelism, I/O execution, or background work. The host owns
the clock and calls `tick(now)`; Insere only advances work that has explicitly
yielded back to that host clock.

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
- The API facade isolates uncaught task failures by default, reports them as
  `InsereResult` failures from `tick()` / `runIdle()`, and keeps explicit
  `bubble` supervision available for development rethrow behavior.

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
  `InsereEventBus`, `waitBusEvent`, `waitUniqueBusEvent`, `emitUnique`,
  listener-only `publish`/`notify`, and explicit supervision policy for large
  host applications

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

Version `0.2.0` is a public pre-release. The core scheduler, API facade,
logging, supervision, mailbox, and benchmark gates are usable, but the API
should still be treated as experimental until real host dogfood stabilizes it.

Start with [`docs/for-human/README.md`](docs/for-human/README.md) for the
short human-facing guide.

Use [`docs/for-llm/README.md`](docs/for-llm/README.md) as the long-form
architecture and maintenance context for LLM/code agents.

Detailed reference docs live under
[`docs/for-llm/reference`](docs/for-llm/reference).

Run `npm run check` for the standard build, test typecheck, test,
export-smoke, and pack gate.
Run `npm run verify:geukbit` for the Geukbit scale stress and benchmark gate,
or `npm run check:release` before cutting a release candidate.
