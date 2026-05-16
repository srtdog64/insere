# Insere Architecture

Insere is a small host-cooperative scheduler for TypeScript applications that
need public control flow.

It is not a standalone executor. It does not execute work independently, own
threads, run worker pools, or hide background scheduling. The host owns the
clock and execution environment; Insere only coordinates keyed work that
cooperatively yields through frame, delay, idle, or Promise-bridge waits.

It intentionally sits below `async` / `await` for frame-sensitive work:

```txt
host clock -> Insere.tick(now) -> runnable routines -> yielded instructions
host clock -> DirectInsereTask.tick(now) -> runnable direct tasks
```

## Layers

```txt
api facade
clock
direct task core
task declarations -> effects -> routines -> runtime -> instructions
```

- `api` provides `InsereApi` and `InsereApiScope`, the recommended facade for
  host adapters. It joins the direct and effect runtimes behind one clock,
  one key space, one scope model, and one policy Result reporting shape.
- `clock` provides the shared internal host-clock layer. It owns the `frame`,
  `now`, and `delta` advancement contract used by both direct and generator
  runtimes.
- `core` provides `DirectInsereTask`, a no-Promise and no-generator scheduler
  for hot keyed orchestration. It owns direct task slots, lazy cancellation,
  frame queues, `:` boundary prefix indexes, host-clock advancement, and
  `delta`.
- `instruction` is the scheduler vocabulary: frame, delay, idle, and Promise
  bridge waits.
- `runtime` owns keyed slots, cancellation, host-clock advancement, and
  dispatch/state access. It exposes `size`, `frame`, `now`, `has(key)`, and
  `keys()` for simple host-side observation, plus `snapshot()` for debugging
  the current wait state of each routine.
- `effect` provides composable generator programs such as `sleep`,
  `sleepUntil`, `waitFrames`, `dispatch`, `access`, `currentKey`,
  `asyncEffect`, `map`, `flatMap`, `attempt`, `recover`, `ensuring`,
  `acquireUseRelease`, `onCancel`, `forEach`, `whileEffect`, `repeat`, and
  `sequence`.
- `task` gives effects stable keys so callers can spawn, restart, cancel, and
  group-cancel work without rewriting runtime calls. Task application policy is
  explicit through `applyTask`: `spawn`, `restart`, or `skip`.
  `InsereTaskScope` can build prefixed child scopes for nested application
  domains and can spawn, restart, cancel, list, or snapshot effects directly
  under that prefix.
- Direct task specs and `DirectInsereTaskScope` apply the same
  `spawn`/`restart`/`skip` policy model to direct callbacks.
- `host` provides `InsereHostAdapter`, a large-host facade that combines the
  API facade, an inbound mailbox, keyed event bus, host-clock helpers,
  supervision policy, and structured logging.
- `mailbox` provides `InsereMailbox` and `waitEvent` for cancellable inbound
  event waits with explicit buffering.
- `event-bus` provides `InsereEventBus`, `waitBusEvent`, and
  `waitUniqueBusEvent` for targeted keyed inbound events, cancellable keyed
  waits, unique-key waits, and listener-only `publish` calls.
- `supervision` defines `InsereFailure` and the post-failure policies:
  `bubble`, `logAndStop`, `dispatchAndStop`, `convertToResult`, and bounded
  `restart`.

The package also exposes `@exornea/insere/api` for applications that want the
facade without importing every lower-level building block from the root entry.

Rejected Promise waits are thrown back into the suspended generator. That keeps
uncaught failures visible to the runtime while allowing `attempt` to capture
failures inside effect programs.

Cancellation finalizers are synchronous callbacks registered through the
routine context. They run in reverse registration order when `cancel`,
`cancelGroup`, `cancelAll`, or `restart` removes a routine.

Direct tasks use the same cancellation and key model, but the task body is a
callback instead of a generator. Use direct tasks for hot restart, next-frame
continuation, and prefix cancellation paths. Use routines/effects when
composition and typed effect helpers matter more than raw scheduling cost.

## Responsibilities

- keyed work slots
- supersession through `restart(key, routine)`
- direct supersession through `DirectInsereTask.restart(key, step)`
- cancellation through `AbortSignal`
- frame, delay, idle, and Promise-bridge waits
- direct next-frame continuation through `DirectInsereTask.waitFrame(key, step)`
- direct system frame loops through `DirectInsereTask.frameLoop(key, step)`
- dispatching results back to the host application

## Non-Goals

- no standalone executor identity
- no Promise replacement
- no worker pool
- no preemptive threading
- no CPU parallelism
- no general job queue
- no hidden retry or scheduling policy; task policy is explicit at application
  boundaries
- no renderer, editor, or engine ownership
- no dependency injection container (see below)

## No Dependency Injection

Insere intentionally ships without a DI container (no `Layer`, no `Context.Tag`,
no scoped service overrides). Reasons:

1. **Out of scope.** Insere positions itself below `async`/`await` as a
   frame-clock task scheduler. A DI system is a framework concern. Adding it
   pulls Insere into application-architecture territory and dilutes the
   "thin layer over the host loop" identity.
2. **Closure capture is sufficient.** Routines are functions, so host services
   are injected by lexical capture at task-construction time. Tests substitute
   services by passing different captures. No tag/lookup machinery required.
3. **`dispatch` and `getState` already cover the core seam.** Routines reach
   host state through these two hooks, set on `Insere`/`DirectInsereTask`/`InsereApi`
   construction. That is the entire host-routine boundary by design.
4. **Target domain rarely needs runtime service swap.** Editors, games, and
   renderers tend to have singleton subsystems (renderer, asset loader, scene
   store) tied to host lifetime, not per-task scope. Per-routine service
   override is not a common pattern in this domain.
5. **Type and runtime cost.** A typed DI surface (à la `Effect<R, E, A>`)
   would require tracking requirements in the routine type, breaking the
   current `(ctx) => Generator<Instruction, T>` signature. A runtime-only DI
   surface adds Map lookups to every service access and is no safer than
   closure capture.
6. **Slippery slope.** A minimal `tag → service` registry is easy to add but
   leads to demands for scoped overrides, layered defaults, and lifecycle
   management. Each step further from the current focus. Easier to refuse at
   the first step.

**Recommended pattern.** Capture services in the factory closure:

```ts
function buildAutosaveTask(deps: { db: Db; clock: Clock }) {
  return function* autosave(ctx: InsereContext) {
    yield delay(deps.clock.intervalMs);
    yield fromPromise(deps.db.write(ctx.getState()));
  };
}

api.applyEffectResult("autosave", buildAutosaveTask({ db, clock }));
```

For tests, pass a different `deps` object. For runtime substitution, rebuild
and `restart`. This pattern composes cleanly with `task()`, `directTask()`,
and `InsereTaskScope` without introducing a new container abstraction.

If a future use case truly cannot be served by closure capture, the smallest
acceptable addition would be a single `runtime.register(tag, service)` /
`ctx.use(tag)` pair with no scoping or lifecycle. Anything beyond that is a
non-goal.

## Naming

`Insere` comes from Latin `inserere`: to insert, weave in, or thread into
place.

Each keyed routine is inserted into a named slot. Restarting a slot supersedes
the previous occupant.
