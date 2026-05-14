# Insere Architecture

Insere is a cooperative scheduler for TypeScript applications that need public
control flow.

It intentionally sits below `async` / `await` for frame-sensitive work:

```txt
host clock -> Insere.tick(now) -> runnable routines -> yielded instructions
host clock -> DirectInsereTask.tick(now) -> runnable direct tasks
```

## Layers

```txt
api facade
direct task core
task declarations -> effects -> routines -> runtime -> instructions
```

- `api` provides `InsereApi` and `InsereApiScope`, the recommended facade for
  host adapters. It joins the direct and effect runtimes behind one clock,
  one key space, one scope model, and one policy Result reporting shape.
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
- dispatching results back to the host application

## Non-Goals

- no Promise replacement
- no worker pool
- no preemptive threading
- no hidden retry or scheduling policy; task policy is explicit at application
  boundaries
- no renderer, editor, or engine ownership

## Naming

`Insere` comes from Latin `inserere`: to insert, weave in, or thread into
place.

Each keyed routine is inserted into a named slot. Restarting a slot supersedes
the previous occupant.
