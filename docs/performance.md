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

Release candidates should use:

```sh
npm run check:release
```

That runs the standard package gate plus the Geukbit scale stress and benchmark
gate. Use `npm run check` for normal local validation when the full benchmark
gate is not needed.

Default workloads:

- `INSERE_BENCH_RESTARTS=100000`
- `INSERE_BENCH_FRAME_TASKS=10000`
- `INSERE_BENCH_CANCEL_TASKS=10000`
- `INSERE_BENCH_MAILBOX_EVENTS=10000`
- `INSERE_BENCH_RESULTS=1000000`
- `INSERE_BENCH_REPEATS=11`

## Latest Local Result

Measured on 2026-05-15 with Node `v22.17.0` on Windows.

This run used `INSERE_BENCH_REPEATS=11`.

| Scenario | Baseline | Insere | Baseline ops/s | Insere ops/s | Best ms | Faster side |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Restart storm | Promise+Map+Abort latest-only | `DirectInsereTask.restart` | 138,496.64 | 23,702,299.12 | 4.22 | Insere 171.14x |
| Frame continuation | `async`/`await Promise.resolve` step | `DirectInsereTask.waitFrame` + `tick` | 25,037,556.33 | 84,530,853.76 | 0.12 | Insere 3.38x |
| Cancel group | Map+AbortController cancelGroup | `DirectInsereTask.cancelGroup` | 136,411.88 | 56,274,620.15 | 0.18 | Insere 412.53x |
| Cancel group mixed | Map+AbortController mixed cancelGroup | `DirectInsereTask` indexed mixed cancelGroup | 273,306.93 | 19,459,038.72 | 0.51 | Insere 71.2x |
| Generator frame routine | `async`/`await Promise.resolve` step | Generator `Insere` frame routine | 25,037,556.33 | 33,908,650.1 | 2.95 | Insere 1.35x |
| Result branch | Direct TS value branch | `InsereResult ok/match` | 182,939,099.57 | 131,187,112.18 | 7.62 | Baseline 1.39x |
| Mailbox fanout | EventTarget once Promise waiters | `InsereMailbox` waitEvent fanout | 15,424,957.58 | 13,360,053.44 | 0.75 | Baseline 1.15x |
| Mailbox consume-one | Promise resolver queue | `InsereMailbox.emitOne` | 12,232,415.9 | 11,449,507.67 | 0.87 | Baseline 1.07x |

## Interpretation

Insere should be compared against the control-flow machinery it replaces, not
against a bare synchronous branch:

- Restart storm compares against Promise plus `Map`, `AbortController`,
  cleanup, and latest-only guard. Direct Insere was about 171x faster.
- Frame continuation measures tasks already waiting for the next host tick.
  Direct Insere was about 3.4x faster than flushing equivalent
  `Promise.resolve` continuations.
- Cancel group measures cancelling 10k keyed tasks by prefix. Direct Insere was
  about 413x faster and completed in 0.18ms in this run.
- Mixed cancel group measures cancelling the `asset:` half of a runtime that
  also contains `preview:` tasks. Direct Insere was about 71x faster and
  completed in 0.51ms.
- `InsereResult ok/match` remains slower than direct value branching. That path
  is not treated as a hot scheduling path.
- `InsereMailbox` fanout is now near parity with a simple `EventTarget`
  once-listener Promise baseline and may win or lose depending on run variance.
  Mailbox still exists for typed matching, buffering policy, and cancellation
  cleanup first.
- `InsereMailbox.emitOne` is near parity with a raw Promise resolver queue and
  provides an explicit consume-one path for queue-like host event handoff.

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

Latest local result, measured on 2026-05-15 with Node `v22.17.0`:

| Scenario | Baseline | Insere | Baseline units/s | Insere units/s | Insere best ms | Faster side |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| per-entity lifecycle cancel | Promise Map+Abort cancel | Insere cancelGroup | 112,877.52 | 874,102.95 | 11.44 | Insere 7.74x |
| script event bus targeted | Map keyed Promise bus | InsereEventBus | 4,457,122.48 | 3,864,584.94 | 1.29 | Baseline 1.15x |
| script event bus direct callbacks | Map keyed callbacks | InsereEventBus publish | 7,552,870.09 | 7,344,300.82 | 0.68 | Baseline 1.03x |
| gameplay tick | Promise microtask gameplay | Insere direct gameplay | 16,766,333.2 | 3,486,993.51 | 8.6 | Baseline 4.81x |
| physics/animation hot loop | Plain TS hot loop | One Insere host task | 910,580,950.65 | 872,752,661.9 | 0.57 | Baseline 1.04x |
| runtime projection restart | Promise latest-only projection | Insere restartDirect projection | 142,978.35 | 13,924,279.77 | 7.18 | Insere 97.39x |

Interpretation:

- Use Insere for lifecycle cancellation and projection restart.
- Use `InsereEventBus.subscribe()` plus `publish()` for hot keyed script
  callbacks.
- Use `waitBusEvent()` for keyed, cancellable script waits when suspension
  semantics matter more than raw event throughput.
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
- Generator runtime wait state uses numeric opcodes internally and maps back to
  public string wait kinds only for snapshots and failure reports.
- Library-created scheduling instructions carry numeric opcodes, so the
  runtime can avoid string dispatch on the common `frame`/`idle`/`delay`/
  `promise` path while still accepting user-created instruction objects by
  `kind`.
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
- `InsereEventBus.publish()` provides a listener-only hot path that skips
  waiter resolution and buffering.
- API-boundary logging exits before `requestId`, `data`, or log record
  allocation when no logger is installed.
