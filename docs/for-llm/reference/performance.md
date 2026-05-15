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
npm run benchmark:gate
npm run benchmark:geukbit
npm run benchmark:geukbit:gate
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

The non-gate benchmark scripts print tables only. Tables report best samples.
The `*:gate` scripts fail the process when conservative median-sample release
ratios are missed. See [`stability.md`](stability.md) for the current gate
thresholds.

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
| Restart storm | Promise+Map+Abort latest-only | `DirectInsereTask.restart` | 144,697.66 | 16,153,523.08 | 6.19 | Insere 111.64x |
| Frame continuation | `async`/`await Promise.resolve` step | `DirectInsereTask.waitFrame` + `tick` | 25,641,025.64 | 84,459,459.46 | 0.12 | Insere 3.29x |
| Cancel group | Map+AbortController cancelGroup | `DirectInsereTask.cancelGroup` | 149,695.89 | 62,617,407.64 | 0.16 | Insere 418.3x |
| Cancel group mixed | Map+AbortController mixed cancelGroup | `DirectInsereTask` indexed mixed cancelGroup | 270,690.21 | 16,869,095.82 | 0.59 | Insere 62.32x |
| Generator frame routine | `async`/`await Promise.resolve` step | Generator `Insere` frame routine | 25,641,025.64 | 26,185,550.81 | 3.82 | Insere 1.02x |
| Result branch | Direct TS value branch | `InsereResult ok/match` | 179,006,157.81 | 128,279,135.4 | 7.8 | Baseline 1.4x |
| Mailbox fanout | EventTarget once Promise waiters | `InsereMailbox` waitEvent fanout | 14,277,555.68 | 11,184,431.27 | 0.89 | Baseline 1.28x |
| Mailbox consume-one | Promise resolver queue | `InsereMailbox.emitOne` | 10,592,098.29 | 7,589,556.77 | 1.32 | Baseline 1.4x |

## Interpretation

Insere should be compared against the control-flow machinery it replaces, not
against a bare synchronous branch:

- Restart storm compares against Promise plus `Map`, `AbortController`,
  cleanup, and latest-only guard. Direct Insere was about 112x faster.
- Frame continuation measures tasks already waiting for the next host tick.
  Direct Insere was about 3.3x faster than flushing equivalent
  `Promise.resolve` continuations.
- Cancel group measures cancelling 10k keyed tasks by prefix. Direct Insere was
  about 418x faster and completed in 0.16ms in this run.
- Mixed cancel group measures cancelling the `asset:` half of a runtime that
  also contains `preview:` tasks. Direct Insere was about 62x faster and
  completed in 0.59ms.
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

Rule of thumb: attaching Insere directly to per-entity hot loops is slow;
attaching it to per-system, per-phase, or per-resource lifecycle boundaries is
fast.

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
| per-entity lifecycle cancel | Promise Map+Abort cancel | Insere cancelGroup | 112,437.88 | 833,500.03 | 12 | Insere 7.41x |
| script event bus targeted | Map keyed Promise bus | InsereEventBus | 4,303,666.72 | 3,166,962.25 | 1.58 | Baseline 1.36x |
| script event bus direct callbacks setup+publish | Map keyed callbacks | InsereEventBus publish | 7,411,799.58 | 7,168,458.78 | 0.7 | Baseline 1.03x |
| script event bus direct callbacks publish-only | Map keyed callbacks hot publish | InsereEventBus hot publish | 19,654,088.05 | 19,538,882.38 | 0.26 | Baseline 1.01x |
| gameplay tick per-entity tasks (discouraged) | Promise microtask gameplay | Insere per-entity direct gameplay | 14,318,442.15 | 3,430,924.06 | 8.74 | Baseline 4.17x |
| gameplay tick system task | Promise microtask gameplay | Insere frameLoop gameplay system | 16,559,947.01 | 943,396,226.42 | 0.03 | Insere 56.97x |
| physics/animation hot loop | Plain TS hot loop | One Insere host task | 524,879,277.77 | 740,850,496.37 | 0.67 | Insere 1.41x |
| runtime projection restart | Promise latest-only projection | Insere restartDirect projection | 139,620.23 | 13,828,580.91 | 7.23 | Insere 99.04x |

Interpretation:

- Use Insere for lifecycle cancellation and projection restart.
- Use Insere at per-system, per-phase, and per-resource lifecycle boundaries,
  not as a per-entity hot-loop scheduler.
- Use `InsereEventBus.subscribe()` plus `notify()` for fire-and-forget hot keyed
  script callbacks when the delivered count is not needed.
- Use `waitBusEvent()` for keyed, cancellable script waits when suspension
  semantics matter more than raw event throughput.
- Do not model gameplay tick as one task per entity. Use one `frameLoop` per
  system or phase and keep the entity loop inside that task.
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
- Direct `frameLoop(key, step)` and API `frameLoop()` encode per-system frame
  loops without scheduling one task per entity.
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
- `InsereEventBus.notify()` is the fire-and-forget listener hot path for callers
  that do not need a delivered count.
- API-boundary logging exits before `requestId`, `data`, or log record
  allocation when no logger is installed.
