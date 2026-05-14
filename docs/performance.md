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
- `INSERE_BENCH_RESULTS=1000000`
- `INSERE_BENCH_REPEATS=11`

## Latest Local Result

Measured on 2026-05-14 with Node `v22.17.0` on Windows.

This run used `INSERE_BENCH_REPEATS=11`.

| Scenario | Baseline | Insere | Baseline ops/s | Insere ops/s | Best ms | Faster side |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Restart storm | Promise+Map+Abort latest-only | `DirectInsereTask.restart` | 137,329.49 | 15,097,302.11 | 6.62 | Insere 109.93x |
| Frame continuation | `async`/`await Promise.resolve` step | `DirectInsereTask.waitFrame` + `tick` | 26,504,108.14 | 85,543,199.31 | 0.12 | Insere 3.23x |
| Cancel group | Map+AbortController cancelGroup | `DirectInsereTask.cancelGroup` | 124,619.29 | 51,975,051.98 | 0.19 | Insere 417.07x |
| Cancel group mixed | Map+AbortController mixed cancelGroup | `DirectInsereTask` indexed mixed cancelGroup | 250,691.28 | 17,391,304.35 | 0.58 | Insere 69.37x |
| Generator frame routine | `async`/`await Promise.resolve` step | Generator `Insere` frame routine | 26,504,108.14 | 31,894,874.49 | 3.14 | Insere 1.2x |
| Result branch | Direct TS value branch | `InsereResult ok/match` | 101,666,310.83 | 99,161,097.12 | 10.08 | Baseline 1.03x |

## Interpretation

Insere should be compared against the control-flow machinery it replaces, not
against a bare synchronous branch:

- Restart storm compares against Promise plus `Map`, `AbortController`,
  cleanup, and latest-only guard. Direct Insere was about 110x faster.
- Frame continuation measures tasks already waiting for the next host tick.
  Direct Insere was about 3.2x faster than flushing equivalent
  `Promise.resolve` continuations.
- Cancel group measures cancelling 10k keyed tasks by prefix. Direct Insere was
  about 417x faster and completed in 0.19ms in this run.
- Mixed cancel group measures cancelling the `asset:` half of a runtime that
  also contains `preview:` tasks. Direct Insere was about 69x faster and
  completed in 0.58ms.
- `InsereResult ok/match` remains slower than direct value branching. That path
  is not treated as a hot scheduling path.

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
