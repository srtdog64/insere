# Insere TODO

This document tracks design work that should stay in Insere, not in a single
host application such as Geukbit.

Insere's product boundary is a small host-cooperative scheduler. Avoid
pulling it toward a standalone executor, worker pool, dependency container, or
general job queue.

## Current Fit For Geukbit

The current runtime is enough for the first Geukbit composition layer:

- keyed editor task slots
- restart/cancel/cancelGroup/cancelAll
- frame, delay, idle, and Promise bridge waits
- `AbortSignal` on every routine
- task scopes for editor subdomains
- observable runtime snapshots
- explicit task application policy: `spawn`, `restart`, and `skip`
- Result helpers for converting thrown failures into values
- resource lifecycle composition through `acquireUseRelease`
- cancellation finalizers through `ctx.onCancel`
- benchmark baseline against plain TypeScript/JavaScript
- direct no-generator task core for hot restart/frame/cancel paths
- direct task specs, policy helpers, and scopes for hot-path host adapters
- host-facing API facade exported from `@exornea/insere/api`

Geukbit can start with an adapter around Insere for:

- viewport drag sessions
- debounced projection rebuilds
- asset import cancellation
- autosave/build/export tasks
- editor command effect orchestration

Entity lifecycle and script runtime composition should stay at recipe level
until repeated host integrations prove that a first-class API is needed. The
generic keyed event bus is already implemented in the framework layer.

## Completed Core Design Items

These items are now designed and implemented in the core API:

- `InsereResult`: `ok`, `err`, `isOk`, `isErr`, `matchResult`, and `attempt`.
- Task policy: `applyTask` and `InsereTaskPolicy` with `spawn`, `restart`, and
  `skip`.
- Task policy Result reports: `applyTaskResult`, `applyDirectTaskResult`,
  `scope.applyResult`, `scope.applyEffectResult`, and
  `scope.applyTaskResult`.
- Task scopes: prefixed keys, direct effect application, scoped cancellation,
  key listing, and filtered snapshots.
- Resource safety: `ensuring`, `recover`, `onCancel`, and
  `acquireUseRelease`.
- Frame/time helpers: `waitFrames`, `sleepUntil`, `currentFrame`,
  `currentTime`, and `currentKey`.
- Packaging: `docs` and `benchmark` are included in package files.
- Release gates: `npm run check` validates build, test typechecking, tests,
  export smoke, and package dry-run; `npm run check:release` also runs the
  Geukbit scale gate.
- Direct core: `DirectInsereTask` / `InsereCore` with `spawn`, `restart`,
  `waitFrame`, `cancel`, `cancelGroup`, `cancelAll`, `tick`, `runIdle`, lazy
  `AbortSignal`, cancellation finalizers, `delta`, and snapshots.
- Direct task layer: `directTask`, `directFrameTask`, `applyDirectTask`,
  `spawnDirectTask`, `restartDirectTask`, `cancelDirectTask`, and
  `DirectInsereTaskScope`.
- API facade: `createInsereApi`, `InsereApi`, and `InsereApiScope` with shared
  direct/effect ticking, scoped keys, cancellation, snapshots, and Result
  policy reports.
- Structured logging: `InsereLogger`, `InsereLogRecord`,
  `createConsoleInsereLogger`, `createBufferedInsereLogger`, and API-boundary
  bug logging for duplicate spawn, invalid task specs, uncaught task failures,
  cancellation/restart failures, and host-provided `requestId` trace ids.
- Framework layer: `InsereHostAdapter`, `InsereMailbox`, `waitEvent`,
  `InsereEventBus`, `waitBusEvent`, `waitUniqueBusEvent`, `emitUnique`,
  listener-only `publish`, `abortable`, and explicit supervision policy with
  `bubble`, `logAndStop`, `dispatchAndStop`, `convertToResult`, and bounded
  `restart`.
- Throw boundary audit: `docs/for-llm/reference/throw-boundaries.md` documents which APIs must
  return `InsereResult` and which low-level/runtime boundaries intentionally
  throw.

## Performance Baseline

`docs/for-llm/reference/performance.md` records the current microbenchmark results.

Current local result, measured on 2026-05-15 with Node `v22.17.0` and
`INSERE_BENCH_REPEATS=11`:

- Direct restart storm is about 171.14x faster than a Promise+Map+Abort
  latest-only implementation.
- Direct frame continuation for 10k already-waiting tasks is about 3.38x faster
  than `async`/`await Promise.resolve` continuation flushing.
- Direct `cancelGroup("asset:")` for 10k keyed tasks is about 412.53x faster
  than Map+AbortController cancellation and completed in 0.18ms.
- Direct mixed `cancelGroup("asset:")` with `preview:` tasks also present is
  about 71.2x faster and completed in 0.51ms through the group index.
- Generator `Insere` frame routine is about 1.35x faster than the Promise frame
  continuation baseline in the reference benchmark.
- Direct value branching is about 1.39x faster than `InsereResult ok/match`.
- `InsereMailbox` fanout is near parity with a simple EventTarget once-listener
  Promise baseline and may win or lose depending on run variance. Mailbox is
  for typed matching, buffering policy, and cancellation cleanup.
- `InsereMailbox.emitOne` is about 1.07x slower than a raw Promise resolver
  queue and provides explicit consume-one semantics for queue-like handoff.
- Geukbit scale benchmark shows lifecycle cancel, projection restart, and
  `frameLoop` system ticks are strong fits. Fire-and-forget event `notify` is
  close to raw Map callbacks, Promise-style keyed waits are slower, and
  per-entity gameplay task scheduling is not a good fit.

Design conclusion:

- Insere must not be used for hot numeric/data loops.
- Insere is slow when attached directly to per-entity hot loops, and fast when
  attached to per-system, per-phase, or per-resource lifecycle boundaries.
- Use `DirectInsereTask` for Geukbit hot orchestration paths: projection
  rebuild supersession, asset preview restart, drag frame continuation,
  gameplay system `frameLoop`, autosave slots, and scene-switch cancellation.
- Use generator/effect Insere for expressive composition where the extra
  abstraction is worth it.
- Insere is for orchestration boundaries where keyed cancellation,
  supersession, Result conversion, policy, and host-clock visibility matter.
- Any mailbox, supervision, or entity lifecycle layer must include a benchmark
  before being promoted into core.

## Completed: Host Adapter Guidance

The recommended host adapter shape is documented in
`docs/for-llm/reference/api.md` and `docs/for-llm/reference/framework.md`.
Hosts should keep renderer, editor, and game-engine
ownership outside Insere while using the facade for one key space, one host
clock, explicit task policy, and supervision.

Reference shape:

```ts
interface TaskRuntimePort {
  tick(now: number): InsereResult<void>;
  runIdle(): InsereResult<void>;
  waitFrame(key: string, step: DirectInsereStep): void;
  frameLoop(key: string, step: DirectInsereFrameLoopStep): boolean;
  applyDirect(
    key: string,
    step: DirectInsereStep,
    policy: InsereTaskPolicy,
    start?: DirectInsereTaskStart
  ): boolean;
  applyDirectResult(
    key: string,
    step: DirectInsereStep,
    policy: InsereTaskPolicy,
    start?: DirectInsereTaskStart
  ): InsereTaskApplyResult;
  apply(key: string, effect: InsereEffect, policy: InsereTaskPolicy): boolean;
  applyResult(
    key: string,
    effect: InsereEffect,
    policy: InsereTaskPolicy
  ): InsereTaskApplyResult;
  restart(key: string, effect: InsereEffect): void;
  cancel(key: string): boolean;
  cancelGroup(prefix: string): number;
  snapshot(): InsereSnapshot;
}
```

- Hosts compute `dt` outside Insere from their own clock and pass `now` to
  `tick(now)`; Insere exposes the resulting `delta`.
- Host applications convert uncaught task failures through explicit supervision
  policy or their own Result layer. API-boundary bug logging is documented in
  `docs/for-llm/reference/logging.md`.
- Host applications choose task policy explicitly:
  - `restart` for superseded work such as projection rebuilds
  - `spawn` for unique sessions where duplicate keys indicate a bug
  - `skip` for autosave/build/import tasks that should not overlap
- Insere remains free of renderer, editor, game-engine, and framework
  ownership.

## Completed: Inbound Event Mailbox

Insere can dispatch events outward and can now wait for inbound events through
`InsereMailbox` and `waitEvent`.

Covered cases:

- `waitEvent("pointerup")`
- `waitEvent((event) => event.type === "animationEnd")`
- entity script `onEvent`
- collision/input/animation events
- collaborative editor command stream events

Implemented constraints:

- Events are explicit host input through `mailbox.emit(event)` or
  `host.emit(event)`.
- Waiting routines remain cancellable through `ctx.signal`.
- Event buffering policy is explicit: `drop`, `latest`, `queue`, or `bounded`.
- The base runtime stays small; mailbox is a framework layer.

Current shape:

```ts
mailbox.emit(event);
yield* waitEvent(mailbox, (event) => event.type === "pointerup")(ctx);
```

Closed decisions:

- High-volume fanout and consume-one paths are covered by `npm run benchmark`.
- Mailbox exposes both semantics explicitly: `emit()` broadcasts to all
  matching waiters, while `emitOne()` consumes only the first matching waiter.

## Completed: Failure Supervision Policy

An uncaught routine failure removes that routine and reports an
`InsereFailure`. The API facade logs it as `kind: "bug"` when a logger exists
and then applies explicit supervision policy.

Implemented supervision policies:

- `bubble`: explicit development policy that rethrows after reporting
- `logAndStop`: default policy; report failure and remove routine
- `dispatchAndStop`: dispatch `{ type: "taskFailed" }`
- `restart`: explicit bounded restart policy
- `convertToResult`: use `attempt`/`InsereResult` to expose failure as a host
  event

Constraints:

- No invisible retry by default; `logAndStop` is the default isolation policy.
- Restart has a bounded `maxRestarts` policy.
- Host logging receives key, frame, now, delta, operation, policy when
  relevant, wait state when reported by the runtime, and cause.
- Do not reuse `InsereTaskPolicy` for supervision. Task policy decides how to
  start work; supervision policy decides how to react after failure.

## Completed: Delta Time Helper

The generator runtime, direct runtime, API facade, and host adapter now expose
`delta`. Effects can read it through `currentDelta()`. Insere still does not
own frame-rate policy; the host owns the clock and passes `now` into `tick(now)`.

## Completed: AbortSignal I/O Convention

Insere provides `ctx.signal` and `abortable()` for I/O integrations.

Documented examples for:

- `fetch(url, { signal })`
- loader APIs that accept an abort signal
- loader APIs that do not support abort and must ignore late completion
- converting uncaught failures into logs/supervision events

This is especially important for asset import, build/export, and collaborative
session connections.

## P3: Entity Lifecycle Composition

Only after mailbox and supervision are settled, define recipes for entity
lifecycle composition.

Target use cases:

- `mount -> waitFrame loop -> unmount`
- component script restart when binding or component data changes
- cancel all scripts under `entity:${entityId}:`
- separate canonical game state from editor/session overlays

Likely key shape:

```txt
entity:{entityId}:script:{scriptId}
entity:{entityId}:animation:{clipId}
editor:drag:{pointerId}
projection:scene:{sceneId}
```

This should remain a recipe unless repeated users need a first-class API.
