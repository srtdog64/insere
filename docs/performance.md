# Insere Performance

Insere is not designed to beat plain TypeScript loops. Its value is explicit
keyed scheduling, cancellation, supersession, host-clock control, Result
conversion, and task policy. The direct task core exists for the hot
orchestration paths where the equivalent Promise implementation also needs
`Map`, `AbortController`, cleanup, and latest-only guards.

Use direct TypeScript when all you need is a tight synchronous loop or a simple
local branch. Use Insere when control flow needs to be visible, cancellable,
restartable, and tied to a host clock.

## Running Benchmarks

```sh
npm run benchmark
```

The benchmark builds `dist` first, then compares the published JavaScript API
against plain TypeScript/JavaScript baselines.

Default workloads:

- `INSERE_BENCH_RESTARTS=100000`
- `INSERE_BENCH_FRAME_TASKS=10000`
- `INSERE_BENCH_CANCEL_TASKS=10000`
- `INSERE_BENCH_MAILBOX_EVENTS=10000`
- `INSERE_BENCH_RESULTS=1000000`
- `INSERE_BENCH_REPEATS=11`

## Latest Local Result

Measured on 2026-05-14 with Node `v22.17.0` on Windows.

This run used `INSERE_BENCH_REPEATS=11`.

| Scenario | Baseline | Insere | Baseline ops/s | Insere ops/s | Best ms | Faster side |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Restart storm | Promise+Map+Abort latest-only | `DirectInsereTask.restart` | 105,263.21 | 15,761,186.5 | 6.34 | Insere 149.73x |
| Frame continuation | `async`/`await Promise.resolve` step | `DirectInsereTask.waitFrame` + `tick` | 16,992,353.44 | 53,390,282.97 | 0.19 | Insere 3.14x |
| Cancel group | Map+AbortController cancelGroup | `DirectInsereTask.cancelGroup` | 104,008.7 | 35,211,267.61 | 0.28 | Insere 338.54x |
| Cancel group mixed | Map+AbortController mixed cancelGroup | `DirectInsereTask` indexed mixed cancelGroup | 162,134.47 | 14,790,711.43 | 0.68 | Insere 91.22x |
| Generator frame routine | `async`/`await Promise.resolve` step | Generator `Insere` frame routine | 16,992,353.44 | 21,811,202.23 | 4.58 | Insere 1.28x |
| Result branch | Direct TS value branch | `InsereResult ok/match` | 104,787,752.41 | 66,534,484.82 | 15.03 | Baseline 1.57x |
| Mailbox fanout | EventTarget once Promise waiters | `InsereMailbox` waitEvent fanout | 13,308,490.82 | 7,118,957.78 | 1.4 | Baseline 1.87x |

## Interpretation

Insere should be compared against the control-flow machinery it replaces, not
against a bare synchronous branch:

- Restart storm compares against Promise plus `Map`, `AbortController`,
  cleanup, and latest-only guard. Direct Insere was about 150x faster.
- Frame continuation measures tasks already waiting for the next host tick.
  Direct Insere was about 3.1x faster than flushing equivalent
  `Promise.resolve` continuations.
- Cancel group measures cancelling 10k keyed tasks by prefix. Direct Insere was
  about 339x faster and completed in 0.28ms in this run.
- Mixed cancel group measures cancelling the `asset:` half of a runtime that
  also contains `preview:` tasks. Direct Insere was about 91x faster and
  completed in 0.68ms.
- `InsereResult ok/match` remains slower than direct value branching. That path
  is not treated as a hot scheduling path.
- `InsereMailbox` fanout is slower than a simple `EventTarget` once-listener
  Promise baseline. Mailbox exists for typed matching, buffering policy, and
  cancellation cleanup, not as a high-volume event bus.

That does not make Insere a poor fit for editor/game/rendering control flow.
It means Insere should stay out of inner numeric loops and per-component hot
paths. Put those in plain TypeScript, then use Insere at the orchestration
boundary where keyed cancellation, task policy, and frame-clock ownership
matter.

## Performance Budget

Current guidance:

- Good: task orchestration, editor gestures, projection rebuilds, autosave,
  imports, export/build jobs, animation/session loops with coarse work.
- Avoid: per-pixel loops, per-entity numeric integration, physics inner loops,
  high-volume event fanout, and tight data transforms.
- Measure before adding hidden policy or mailbox buffering to the core runtime.

The benchmark is intentionally small and should be treated as a regression
guard, not a product-level latency model.

## Geukbit Scale Benchmark

Run:

```sh
npm run benchmark:geukbit
```

Latest local result, measured on 2026-05-14 with Node `v22.17.0`:

| Scenario | Baseline | Insere | Baseline units/s | Insere units/s | Insere best ms | Faster side |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| per-entity lifecycle cancel | Promise Map+Abort cancel | Insere cancelGroup | 101,314.04 | 791,916.12 | 12.63 | Insere 7.82x |
| script event bus targeted | Map keyed Promise bus | InsereEventBus | 4,080,300.31 | 3,192,032.69 | 1.57 | Baseline 1.28x |
| gameplay tick | Promise microtask gameplay | Insere direct gameplay | 15,568,240.79 | 3,054,647.65 | 9.82 | Baseline 5.1x |
| physics/animation hot loop | Plain TS hot loop | One Insere host task | 856,457,690.99 | 809,323,405.63 | 0.62 | Baseline 1.06x |
| runtime projection restart | Promise latest-only projection | Insere restartDirect projection | 112,918.57 | 1,070,047.45 | 93.45 | Insere 9.48x |

Interpretation:

- Use Insere for lifecycle cancellation and projection restart.
- Use `InsereEventBus` for keyed, cancellable script waits when the semantics
  matter more than raw event throughput.
- Do not model gameplay tick as one task per entity.
- Keep physics and animation inner loops in plain TypeScript under one host
  task.

## Current Optimizations

The runtime keeps the public model unchanged while avoiding avoidable work:

- `frame()` and `idle()` return singleton instruction objects.
- Readiness checks are inlined in `#resumeIfReady` to avoid per-tick result
  object allocation.
- Single-entry `tick()` and `runIdle()` avoid allocating an entry snapshot
  array.
- Single-entry runtimes keep a cached entry pointer and avoid a per-tick Map
  iterator.
- Hot-path resume no longer re-checks `Map.has(key)` for the entry already
  being resumed.
- Runtime wait state is stored as flat entry fields (`wait`, `waitFrame`,
  `wakeAt`, `promiseToken`) instead of allocating wait-state objects for every
  frame or delay yield.
- `AbortController` is created lazily only when `ctx.signal` is read.
- Cancellation finalizer storage is created lazily only when `ctx.onCancel` is
  used.
- `DirectInsereTask` separates the no-Promise, no-generator path from the
  expressive generator/effect path.
- Direct task context is shared during execution instead of allocated per task.
- Direct task cancellation and finalizer fields are flattened into the entry
  object.
- Direct `waitFrame(key, step)` registers already-waiting frame continuations
  without an initial branch run.
- Direct frame tick uses a frame queue and a bulk-clear fast path when all
  waiting tasks complete in the same tick.
- Direct restart overwrites finalizer-free superseded slots without a separate
  `Map.delete`.
- Direct cancellation stores a single finalizer as a bare callback and only
  promotes to a `Set` when multiple finalizers are registered.
- Direct `cancelGroup` bulk-clears when every active key matches the prefix.
- Direct `cancelGroup` indexes `:` boundary prefixes such as `asset:`,
  `preview:`, and `entity:1:` for mixed-runtime group cancellation.
