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
ratios or absolute median caps are missed. See [`stability.md`](stability.md)
for the current gate thresholds.

Default workloads:

- `INSERE_BENCH_RESTARTS=100000`
- `INSERE_BENCH_FRAME_TASKS=10000`
- `INSERE_BENCH_CANCEL_TASKS=10000`
- `INSERE_BENCH_MAILBOX_EVENTS=10000`
- `INSERE_BENCH_RESULTS=1000000`
- `INSERE_BENCH_REPEATS=11`

## Representative Local Result

Representative gate run measured on 2026-05-15 with Node `v22.17.0` on
Windows. Benchmark samples vary by host load; the release contract is the gate
thresholds, not the exact table values below.

This run used `INSERE_BENCH_REPEATS=11`.

| Scenario | Baseline | Insere | Baseline ops/s | Insere ops/s | Best ms | Faster side |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Restart storm | Promise+Map+Abort latest-only | `DirectInsereTask.restart` | 140,089.97 | 21,437,605.85 | 4.66 | Insere 153.03x |
| Frame continuation | `async`/`await Promise.resolve` step | `DirectInsereTask.waitFrame` + `tick` | 23,062,730.63 | 60,060,060.06 | 0.17 | Insere 2.6x |
| Cancel group | Map+AbortController cancelGroup | `DirectInsereTask.cancelGroup` | 123,997.17 | 50,327,126.32 | 0.2 | Insere 405.87x |
| Cancel group mixed | Map+AbortController mixed cancelGroup | `DirectInsereTask` indexed mixed cancelGroup | 277,726.09 | 18,014,772.11 | 0.56 | Insere 64.87x |
| Generator frame routine | `async`/`await Promise.resolve` step | Generator `Insere` frame routine | 23,062,730.63 | 31,737,971.31 | 3.15 | Insere 1.38x |
| Result branch | Direct TS value branch | `InsereResult ok/match` | 184,478,019.44 | 129,480,008.29 | 7.72 | Baseline 1.42x |
| Mailbox fanout | EventTarget once Promise waiters | `InsereMailbox` waitEvent fanout | 12,550,200.8 | 12,978,585.33 | 0.77 | Insere 1.03x |
| Mailbox consume-one | Promise resolver queue | `InsereMailbox.emitOne` | 11,994,722.32 | 11,199,462.43 | 0.89 | Baseline 1.07x |
| Script event bus unique targeted | Map keyed Promise event bus | `InsereEventBus.waitUnique` + `emitUnique` | 7,286,505.39 | 6,129,704.55 | 0.82 | Baseline 1.19x |

## Interpretation

Insere should be compared against the control-flow machinery it replaces, not
against a bare synchronous branch:

- Restart storm compares against Promise plus `Map`, `AbortController`,
  cleanup, and latest-only guard. Direct Insere was about 153x faster.
- Frame continuation measures tasks already waiting for the next host tick.
  Direct Insere was about 2.6x faster than flushing equivalent
  `Promise.resolve` continuations.
- Cancel group measures cancelling 10k keyed tasks by prefix. Direct Insere was
  about 406x faster and completed in 0.2ms in this run.
- Mixed cancel group measures cancelling the `asset:` half of a runtime that
  also contains `preview:` tasks. Direct Insere was about 65x faster and
  completed in 0.56ms.
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

Representative local result, measured on 2026-05-15 with Node `v22.17.0`:

| Scenario | Baseline | Insere | Baseline units/s | Insere units/s | Insere best ms | Faster side |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| per-entity lifecycle cancel | Promise Map+Abort cancel | Insere cancelGroup | 103,206.95 | 859,675.21 | 11.63 | Insere 8.33x |
| script event bus targeted | Map keyed Promise bus | InsereEventBus unique waits | 4,214,785.47 | 3,799,969.6 | 1.32 | Baseline 1.11x |
| script event bus direct callbacks setup+publish | Map keyed callbacks | InsereEventBus publish | 7,246,376.81 | 6,679,134.38 | 0.75 | Baseline 1.08x |
| script event bus direct callbacks publish-only | Map keyed callbacks hot publish | InsereEventBus hot publish | 19,142,419.6 | 18,860,807.24 | 0.27 | Baseline 1.01x |
| gameplay tick per-entity tasks (discouraged) | Promise microtask gameplay | Insere per-entity direct gameplay | 16,056,518.95 | 1,085,670.24 | 27.63 | Baseline 14.79x |
| gameplay tick system task | Promise microtask gameplay | Insere frameLoop gameplay system | 7,868,026.96 | 591,715,976.33 | 0.05 | Insere 75.21x |
| physics/animation hot loop | Plain TS hot loop | One Insere host task | 506,482,982.17 | 409,366,300.97 | 1.22 | Baseline 1.24x |
| runtime projection restart | Promise latest-only projection | Insere restartDirect projection | 123,251.04 | 9,915,323.14 | 10.09 | Insere 80.45x |

Interpretation:

- Use Insere for lifecycle cancellation and projection restart.
- Use Insere at per-system, per-phase, and per-resource lifecycle boundaries,
  not as a per-entity hot-loop scheduler.
- Use `InsereEventBus.subscribe()` plus `notify()` for fire-and-forget hot keyed
  script callbacks when the delivered count is not needed.
- Use `waitUniqueBusEvent()` / `emitUniqueTo()` for keyed, cancellable script
  waits when the host guarantees at most one suspended waiter per key.
- Use `waitBusEvent()` for keyed waits that need full multi-waiter semantics.
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
- Direct and effect runtimes keep flat entry lists for hot tick/idle iteration;
  `Map` remains the keyed lookup index, but steady tick does not allocate a
  `Map.values()` iterator.
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
  promotes to an array when multiple finalizers are registered, so reverse
  finalizer execution does not allocate a spread/reverse copy.
- Direct `cancelGroup` bulk-clears when every active key matches the prefix.
- Direct `cancelGroup` indexes `:` boundary prefixes such as `asset:`,
  `preview:`, and `entity:1:` for mixed-runtime group cancellation.
- Direct `cancelGroup` fallback scans the flat entry list instead of allocating
  a `Map` iterator when no boundary-prefix index exists.
- `InsereEventBus.publish()` provides a listener-only hot path that skips
  waiter resolution and buffering.
- `InsereEventBus.notify()` is the fire-and-forget listener hot path for callers
  that do not need a delivered count.
- `InsereEventBus.publish()` and `notify()` inline the single-listener branch
  because this path competes directly with raw `Map.get(key)?.(event)`.
- `InsereEventBus.emit()` has a no-listener one-shot waiter fast path. It still
  may trail a raw `Map.set`/`Map.get` Promise bus for unique keys because
  `wait()` preserves multi-waiter-per-key semantics and must check the existing
  slot at registration time.
- `InsereEventBus.waitUnique()` and `emitUnique()` provide the explicit
  unique-key waiter path. This path skips listeners and buffering, rejects
  duplicate unique waiters, and is the right suspension API when the host owns
  key uniqueness.
- `InsereMailbox.wait()` stores no-match/no-signal waits as bare resolver
  functions, so `emitOne()` does not pay structured waiter object overhead for
  the Promise resolver queue equivalent.
- Mailbox and event-bus `wait()` avoid allocating a default options object when
  no `AbortSignal` is supplied.
- API-boundary logging exits before `requestId`, `data`, or log record
  allocation when no logger is installed.

## Remaining Promise Parity Boundaries

- `InsereEventBus.wait(key)` is intentionally richer than a raw `Map` of
  one-shot Promise callbacks. It supports multiple waiters per key, buffering
  policy, cancellation, and listener coexistence.
- `InsereEventBus.waitUnique(key)` narrows that contract to one pending waiter
  per key. It removes the multi-waiter delivery path, but it still returns a
  Promise, so raw callback baselines can remain faster when they do work inside
  the callback before resolving.
- `InsereMailbox.emitOne()` is now near parity with raw Promise resolver queues.
  Treat small wins or losses as variance unless a gate fails repeatedly.
- Per-entity task scheduling remains a misuse case. The Promise microtask
  baseline is faster there because it does less policy work; use one Insere
  `frameLoop` per system and keep entity iteration inside plain TypeScript.
