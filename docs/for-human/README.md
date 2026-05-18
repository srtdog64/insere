# Insere For Humans

Insere is a tiny cooperative scheduler for restart-heavy, frame-driven,
cancellable TypeScript editor workloads.

It is not a Promise replacement, worker pool, or general job queue. Use it when
work has a stable key, newer work should supersede older work, and the host
already owns the frame clock.

## Install

```sh
npm install @exornea/insere
```

## Use It For

- projection rebuild supersession
- drag or preview work that resumes on the next frame
- autosave or import slots where overlap should be skipped or restarted
- scene or document switches that cancel a group of keyed work
- host-scale logging and supervision around editor orchestration

## Avoid It For

- replacing `async` / `await`
- CPU parallelism or worker pools
- per-entity physics, animation, or gameplay inner loops
- tight numeric transforms that plain TypeScript already handles well
- product-domain adapters such as document, cursor, selection, CRDT, or canvas
  policy

## Fast Start

Use the API facade for host adapters:

```ts
import { createInsereApi } from "@exornea/insere/api";

const api = createInsereApi({
  dispatch: (event) => editor.dispatch(event),
  logger
});

api.applyDirectResult("projection:scene", (ctx) => {
  rebuildProjection(ctx.delta);
}, "restart");

api.applyDirectResult("preview:drag", () => {
  updateDragPreview();
}, "restart", "frame");

api.frameLoopResult("gameplay:systems", (ctx) => {
  runGameplaySystems(ctx.delta);
  return scene.isRunning;
});

api.tick(performance.now());
```

Use effects when composition matters more than hot-path cost:

```ts
import { createInsereApi, dispatch, sequence, sleep } from "@exornea/insere";

const api = createInsereApi();

api.applyEffectResult(
  "autosave",
  sequence([sleep(250), dispatch({ type: "autosave:flush" })]),
  "skip"
);
```

## Mental Model

- The host owns time and calls `tick(now)`.
- Insere owns keyed slots and cancellation.
- Insere is single-threaded; worker pools and CPU parallelism stay in the host.
- The real concurrency risk is reentrancy during `tick()`, so old work must not
  resurrect or overwrite a newer keyed occupant.
- `restart` replaces active work for the same key.
- `skip` prevents overlapping work.
- `cancelGroup("asset:")` cancels all matching keyed work.
- Direct tasks are the hot path.
- Effects are the expressive path.
- `waitUniqueBusEvent()` is for keyed inbound events with at most one suspended
  waiter; use `notifyTo()` for hot fire-and-forget listener callbacks.
- Logging is structured and disabled logging is a fast no-op.
- API `tick()` isolates task failures by default and returns a failed Result;
  use explicit `bubble` supervision when development builds should rethrow.

## Release Check

```sh
npm run check:release
```

That runs build, test typecheck, tests, export smoke, pack dry-run, P0
benchmark gates, and Geukbit-scale stress/benchmark gates.

Before publishing:

```sh
npm publish --dry-run --access public
npm publish --access public --otp=<code>
```

## Read More

- LLM/deep reference: [`../for-llm/README.md`](../for-llm/README.md)
- API facade: [`../for-llm/reference/api.md`](../for-llm/reference/api.md)
- Scheduler atomicity:
  [`../for-llm/reference/atomicity.md`](../for-llm/reference/atomicity.md)
- Performance: [`../for-llm/reference/performance.md`](../for-llm/reference/performance.md)
- Stability and release gates:
  [`../for-llm/reference/stability.md`](../for-llm/reference/stability.md)
