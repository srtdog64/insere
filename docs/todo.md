# Insere TODO

This document tracks design work that should stay in Insere, not in a single
host application such as Geukbit.

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

Entity lifecycle and script event bus should wait until the items below are
designed.

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
- Direct core: `DirectInsereTask` / `InsereCore` with `spawn`, `restart`,
  `waitFrame`, `cancel`, `cancelGroup`, `cancelAll`, `tick`, `runIdle`, lazy
  `AbortSignal`, cancellation finalizers, `delta`, and snapshots.
- Direct task layer: `directTask`, `directFrameTask`, `applyDirectTask`,
  `spawnDirectTask`, `restartDirectTask`, `cancelDirectTask`, and
  `DirectInsereTaskScope`.
- API facade: `createInsereApi`, `InsereApi`, and `InsereApiScope` with shared
  direct/effect ticking, scoped keys, cancellation, snapshots, and Result
  policy reports.

## Performance Baseline

`docs/performance.md` records the current microbenchmark results.

Current local result, measured on 2026-05-14 with Node `v22.17.0` and
`INSERE_BENCH_REPEATS=11`:

- Direct restart storm is about 109.93x faster than a Promise+Map+Abort
  latest-only implementation.
- Direct frame continuation for 10k already-waiting tasks is about 3.23x faster
  than `async`/`await Promise.resolve` continuation flushing.
- Direct `cancelGroup("asset:")` for 10k keyed tasks is about 417.07x faster
  than Map+AbortController cancellation and completed in 0.19ms.
- Direct mixed `cancelGroup("asset:")` with `preview:` tasks also present is
  about 69.37x faster and completed in 0.58ms through the group index.
- Generator `Insere` frame routine is about 1.2x faster than the Promise frame
  continuation baseline in the reference benchmark.
- Direct value branching is about 1.03x faster than `InsereResult ok/match`.

Design conclusion:

- Insere must not be used for hot numeric/data loops.
- Use `DirectInsereTask` for Geukbit hot orchestration paths: projection
  rebuild supersession, asset preview restart, drag frame continuation,
  autosave slots, and scene-switch cancellation.
- Use generator/effect Insere for expressive composition where the extra
  abstraction is worth it.
- Insere is for orchestration boundaries where keyed cancellation,
  supersession, Result conversion, policy, and host-clock visibility matter.
- Any mailbox, supervision, or entity lifecycle layer must include a benchmark
  before being promoted into core.

## P0: Host Adapter Guidance

- Document the recommended host adapter shape:

```ts
interface TaskRuntimePort {
  tick(now: number): void;
  runIdle(): void;
  waitFrame(key: string, step: DirectInsereStep): void;
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

- Document how a host should compute `dt` outside Insere from `now`.
- Document how host applications should convert uncaught task failures into
  their own Result/logging systems.
- Document how host applications should choose task policy:
  - `restart` for superseded work such as projection rebuilds
  - `spawn` for unique sessions where duplicate keys indicate a bug
  - `skip` for autosave/build/import tasks that should not overlap
- Keep Insere free of renderer, editor, game-engine, and framework ownership.

## P1: Inbound Event Mailbox

Insere can dispatch events outward, but routines cannot currently wait for
inbound events.

Design a small event mailbox layer for cases like:

- `waitEvent("pointerup")`
- `waitEvent((event) => event.type === "animationEnd")`
- entity script `onEvent`
- collision/input/animation events
- collaborative editor command stream events

Constraints:

- Events must be explicit host input, not hidden global state.
- Waiting routines must remain cancellable.
- Event buffering policy must be explicit: drop, latest, queue, or bounded
  queue.
- The base runtime should stay small; mailbox may be an optional layer.

Possible shape:

```ts
runtime.emit(event);
yield waitEvent((event) => event.type === "pointerup");
```

Open questions:

- Should mailbox live in core runtime or in a separate effect adapter?
- Should event matching be typed through `TEvent`?
- How should unmatched events be retained or discarded?

## P1: Failure Supervision Policy

Today an uncaught routine failure removes that routine and throws to the host
tick/restart caller. That is correct for a small core, but host applications
need policy hooks.

Design supervision at the boundary, not as hidden retry magic:

- `bubble`: current behavior
- `logAndStop`: report failure and remove routine
- `dispatchAndStop`: dispatch `{ type: "taskFailed" }`
- `restart`: explicit bounded restart policy
- `convertToResult`: use `attempt`/`InsereResult` to expose failure as a host
  event

Constraints:

- No invisible retry by default.
- Restart must have a bounded policy.
- Host logging should receive key, wait state, frame, now, and cause.
- Do not reuse `InsereTaskPolicy` for supervision. Task policy decides how to
  start work; supervision policy decides how to react after failure.

## P2: Delta Time Helper

The generator runtime exposes `now` and `frame`, while `DirectInsereTask`
also exposes `delta`. Generator `dt` is currently host-owned. This is
acceptable, but common enough to document or add a helper.

Options:

- Keep `dt` host-only and document it.
- Add `previousNow` and `delta` to `InsereContext`.
- Add a host adapter recipe instead of adding generator runtime state.

For now, prefer `DirectInsereTask.delta` for hot direct paths and a host
adapter recipe for generator/effect paths. Insere should not assume frame-rate
semantics beyond host-clock advancement.

## P2: AbortSignal I/O Convention

Insere provides `ctx.signal`, but I/O integrations need a clear convention.

Document examples for:

- `fetch(url, { signal: ctx.signal })`
- loader APIs that accept an abort signal
- loader APIs that do not support abort and must ignore late completion
- converting cancellation into host Result/log events

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
