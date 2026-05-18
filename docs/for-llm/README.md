# Insere For LLMs

This document is the long-form context pack for agents working on Insere. Read
it before making architectural, API, performance, logging, or release changes.
Human-facing docs should stay short in `docs/for-human/README.md`; this file is
allowed to be redundant and explicit so an agent can preserve the design model.

## Product Position

Insere is a tiny cooperative scheduler for restart-heavy, frame-driven,
cancellable TypeScript editor workloads.

Do not describe Insere as a faster Promise, a Promise replacement, a standalone
executor, or a general task framework. The accurate comparison is against the
control-flow machinery hosts otherwise write around Promise: keyed `Map`
registries, `AbortController`, latest-only guards, cleanup, frame callbacks,
and group cancellation.

The intended host shape is an editor, renderer, game tool, or collaborative
canvas that already owns the event loop and frame clock. Insere does not own
threads, worker pools, I/O execution, rendering, domain state, or background
work.

Preferred short description:

```txt
A small cooperative scheduler for keyed, cancellable TypeScript editor workloads.
```

## Boundary Rules

Allowed inside Insere:

- keyed direct and effect scheduling
- direct hot-path callbacks
- generator/effect orchestration
- `frameLoop` system loops
- `cancel`, `cancelGroup`, and keyed supersession
- mailbox and keyed event-bus primitives
- Result, policy, supervision, and structured bug logging
- host hooks such as `dispatch`, `getState`, `requestId`, and `logger`
- benchmarks, stress witnesses, and release gates

Not allowed inside Insere:

- Geukbit-specific adapters
- document, workspace, user, cursor, selection, entity, projection, presence,
  undo/redo, CRDT, or OT semantics
- canvas-specific coalescing policy
- product-specific key naming
- application lifecycle ownership
- a dependency injection container
- worker-pool or CPU-parallel execution

Domain adapters belong in the host repository. Insere should remain the generic
small cooperative scheduler below those adapters.

## Layer Model

```txt
host app
  InsereHostAdapter
    InsereApi
      InsereClock
      DirectInsereTask
      Insere generator runtime
    InsereMailbox
    InsereEventBus
    supervision policy
    structured logging
```

Key layers:

- `@exornea/insere/api` is the recommended host-facing facade. It joins direct
  tasks and effects behind one clock, one key space, one scope model, one
  Result shape, and one supervision/logging boundary.
- `InsereClock` is the internal clock layer shared by direct and generator
  runtimes. It owns `frame`, `now`, and `delta` advancement semantics so both
  runtimes observe the same host-clock model.
- `DirectInsereTask` is the no-Promise and no-generator core for hot keyed
  orchestration. Use it for restart storm, frame continuation, system
  `frameLoop`, and prefix cancellation paths.
- `Insere` is the generator runtime. Use it when yielded instructions,
  Promise bridges, and routine snapshots matter.
- `effect` provides composable generator programs for colder orchestration:
  `sleep`, `waitFrame`, `awaitPromise`, `attempt`, `recover`, `ensuring`,
  `acquireUseRelease`, `sequence`, loops, and state/dispatch helpers.
- `task` binds effects or direct callbacks to stable keys and explicit
  `spawn` / `restart` / `skip` policy.
- `host` combines API, mailbox, event bus, supervision, logging, and one host
  clock for large applications.

## Policy Invariants

Task application policy is separate from failure supervision.

Task policies:

- `restart`: cancel and replace work at the same key.
- `spawn`: start only when the key is free; duplicate keys are errors in
  Result-returning APIs and throw from boolean/imperative lower-level APIs.
- `skip`: start only when the key is free; duplicate keys return an unapplied
  successful Result.

Supervision policies:

- `bubble`: explicit development policy that rethrows the original failure.
- `logAndStop`: default isolation policy that logs/reports and leaves the
  failed task stopped.
- `dispatchAndStop`: convert failure into a host event.
- `convertToResult`: send a failed Result to the host callback.
- `restart`: restart API-owned work up to a bounded restart count.

Lower runtimes must isolate task failures. A task exception is converted into
`InsereFailure`, the failed task is removed, and unrelated runnable tasks keep
their opportunity to advance. API `tick()` / `runIdle()` return `err(failure)`
for the first failure unless an explicit `bubble` policy rethrows.
Host-provided supervision callbacks are also isolated under non-`bubble`
policies and logged as bug records if they throw.

Scheduler atomicity is single-threaded and slot-oriented. Insere does not own
worker threads, shared memory, atomics, or CPU parallelism. Reentrancy is the
important edge: a task may call `restart`, `cancel`, or `cancelGroup` while
`tick()` is running, and the old keyed occupant must not resurrect or overwrite
the newer occupant. See [`reference/atomicity.md`](reference/atomicity.md).

Keep policy names and meanings consistent between direct tasks, effects,
scopes, API facade, and host adapter.

## Result And Throw Boundaries

Use `InsereResult<T>` and structured `AppError` at host-facing policy and
failure boundaries. `AppError` carries `code`, `message`, `stage`, optional
`retryable`, optional `cause`, and optional `meta`.

Normal policy decisions should be values:

- skipped work is `ok({ applied: false, status: "skipped" })`
- duplicate `spawn` in Result APIs is `err(AppError)`
- invalid task specs in Result APIs are `err(AppError)`
- API `tick` and `runIdle` return `InsereResult<void>`

Intentional throw boundaries still exist at low-level imperative APIs and
process/setup edges. Do not remove all throws blindly; keep them only where the
API contract is intentionally imperative or the process cannot continue.

Under `exactOptionalPropertyTypes`, omit optional fields instead of setting
them to `undefined`.

## Logging Contract

Logging is for bug records at API/host boundaries. It should be structured JSON
with `ts`, `stage`, `event`, and enough identity to trace the failure.

Performance rule: if no logger is installed, logging must exit before reading
`requestId`, building `data`, or allocating a log record.

Bug records are appropriate for:

- duplicate `spawn`
- invalid task specs
- uncaught task failures
- cancellation finalizer failures
- supervision restart exhaustion

Do not log normal `skip` or normal `restart` policy decisions as bugs.

## Performance Contract

Insere does not need to beat bare `Promise.resolve()` or plain TypeScript in all
cases. It must justify itself against equivalent control-flow machinery.

P0 benchmark targets:

- restart storm: same key restarted many times, only latest runs; compare
  against Promise + `Map` + `AbortController` + cleanup + latest guard.
- frame continuation: many direct tasks waiting for the next host tick; compare
  against async/await Promise frame steps.
- cancel group: many keyed tasks cancelled by prefix; compare against Map scan
  + AbortController + cleanup.
- mixed cancel group: prefix cancellation in a runtime with multiple groups.

Geukbit-scale targets:

- lifecycle cancellation should beat Promise Map+Abort.
- projection restart should beat Promise latest-only projection.
- gameplay should use one `frameLoop` per system or phase, not one task per
  entity. `frameLoop` callbacks return `true` to continue and `false` to stop.
- physics/animation numeric loops should remain plain TypeScript under one
  host task.
- event-bus listener hot paths may be near parity with raw keyed callbacks;
  they exist for keyed subscriptions and cancellation, not universal speed.

Release gates use conservative median-sample ratios plus absolute median caps
on default benchmark sizes. Printed benchmark tables show best samples for
readability.

## API Preference

Prefer `createInsereApi()` for host adapters:

```ts
import { createInsereApi } from "@exornea/insere/api";

const api = createInsereApi({
  dispatch,
  getState,
  logger,
  requestId: () => host.currentRequestId
});

api.applyDirectResult("projection:scene", rebuildProjection, "restart");
api.applyDirectResult("preview:drag", updatePreview, "restart", "frame");
api.frameLoopResult("gameplay:systems", runGameplaySystems);
api.applyEffectResult("autosave", autosaveEffect, "skip");
api.tick(performance.now());
```

`frameLoop` callbacks must return `true` to continue and `false` to stop. Do
not use an omitted return as "continue"; 0.2 makes the continuation decision
explicit to avoid accidental infinite loops.

Use direct tasks for hot orchestration:

- projection rebuild supersession
- drag preview frame continuation
- autosave slots
- asset preview restart
- scene-switch cancellation
- one system-level gameplay/animation loop

Use effects for expressive orchestration:

- Promise bridges
- `attempt` / `recover`
- resource lifecycle helpers
- sequential workflows
- reusable effect declarations

Avoid using Insere as a per-entity hot-loop scheduler.

## Host Adapter Convention

The host owns:

- the clock and call to `tick(now)`
- rendering
- I/O
- workers
- domain state
- event source ownership

Insere owns:

- keyed task slots
- supersession
- cancellation
- frame/delay/idle continuation
- mailbox waits
- keyed event waits and subscriptions
- supervision policy
- structured bug records

Inbound broad events should use `InsereMailbox`. Targeted script/entity events
should use `InsereEventBus`. Use `notifyTo()` or `publishTo()` for listener hot
paths, `waitUniqueBusEvent()` / `emitUniqueTo()` when the host guarantees one
suspended waiter per key, and `waitBusEvent()` only when a task needs the full
multi-waiter keyed event semantics.

## Release Discipline

Normal local validation:

```sh
npm run check
```

Release-candidate validation:

```sh
npm run check:release
```

Publish validation:

```sh
npm publish --dry-run --access public
npm publish --access public --otp=<code>
```

`prepublishOnly` runs `check:publish`, which runs `check:release`. Do not weaken
this unless the package is explicitly moved to a different release process.

## Reference Map

Detailed source docs live under `docs/for-llm/reference/`:

- [`api.md`](reference/api.md): API facade, policy Result shape, requestId, and
  choosing direct vs effect.
- [`architecture.md`](reference/architecture.md): layer model, non-goals,
  dependency-injection decision, and naming.
- [`framework.md`](reference/framework.md): host adapter, mailbox, event bus,
  frame loops, supervision, and AbortSignal convention.
- [`logging.md`](reference/logging.md): structured bug logging and no-logger
  performance contract.
- [`performance.md`](reference/performance.md): benchmark commands, current
  local results, interpretation, and optimization list.
- [`semantics.md`](reference/semantics.md): routine, effect, task, direct core,
  framework, cancellation, and Promise bridge semantics.
- [`stability.md`](reference/stability.md): package boundary, public
  entrypoints, release gates, and compatibility rules.
- [`throw-boundaries.md`](reference/throw-boundaries.md): Result boundaries and
  intentional throws.
- [`todo.md`](reference/todo.md): design status and future host-facing recipes.

When editing, update the reference file that owns the detail and keep this
LLM context accurate enough for future agents to avoid re-litigating settled
design choices.
