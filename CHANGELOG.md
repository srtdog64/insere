# Changelog

## 0.2.0

Insere `0.2.0` tightens the package around its intended role: a small
cooperative scheduler for keyed, cancellable TypeScript editor workloads.

### Changed

- Default API supervision is now `logAndStop`.
  - Uncaught task failures are isolated by default.
  - `api.tick()` and `api.runIdle()` return `err(failure)` for the first
    failure instead of rethrowing.
  - Explicit `bubble` supervision remains available for development builds
    that should rethrow after reporting.
- `DirectInsereFrameLoopStep` now returns `boolean`.
  - `true` continues the frame loop.
  - `false` stops the frame loop.
  - Omitted returns are no longer accepted by TypeScript.
- Documentation is split into human and LLM/agent tracks:
  - `docs/for-human/README.md`
  - `docs/for-llm/README.md`
  - `docs/for-llm/reference/*`

### Added

- `InsereClock`, the internal shared clock layer used by direct and generator
  runtimes.
- Common context base types exported from the root package:
  - `InsereBaseContext`
  - `InsereCancellationContext`
- Unique-key event bus APIs for dogfood hosts that can guarantee one suspended
  waiter per key:
  - `InsereEventBus.waitUnique`
  - `InsereEventBus.emitUnique`
  - `InsereEventBus.waitUniqueEffect`
  - `waitUniqueBusEvent`
  - `InsereHostAdapter.emitUniqueTo`
  - `InsereHostAdapter.waitUniqueBusEvent`
- Explicit unsafe wrapper names for throw-oriented command paths:
  - `applyTaskUnsafe`
  - `applyDirectTaskUnsafe`
  - `InsereApi.applyDirectUnsafe`
  - `InsereApi.applyEffectUnsafe`
  - `InsereApi.waitFrameUnsafe`
  - `InsereApi.frameLoopUnsafe`
- Root `AGENT.md` policy for Result-first boundaries, unsafe wrappers,
  structured logging, host-clock timing, and event-bus semantics.
- Reentrant direct-core tests for frame queue draining and `cancelGroup`.
- Failure-isolation tests that verify later runnable direct tasks and effect
  routines still advance after one task fails.
- Release gates now include conservative median ratios and absolute median caps
  for default benchmark sizes.

### Improved

- Direct and effect runtimes now keep flat entry lists for hot `tick()` /
  `runIdle()` iteration while retaining `Map` for keyed lookup.
- Direct frame queues are reused instead of replaced with new arrays during
  frame draining.
- Direct finalizers no longer allocate a spread/reverse copy for reverse-order
  execution.
- Direct `cancelGroup` fallback scans the flat entry list instead of allocating
  `Map` iterators when no group index exists for the prefix.
- Mailbox waits without matcher or `AbortSignal` now store a bare resolver
  slot, improving `emitOne` against raw Promise resolver queues.
- Mailbox and event-bus `wait()` calls no longer allocate a default options
  object when no options are supplied.
- Event-bus `publish()` and `notify()` inline the single-listener hot path to
  stay closer to raw `Map.get(key)?.(event)` callbacks.
- Event-bus `emit()` has a no-listener one-shot waiter fast path for Promise
  Map style keyed waits.
- Event-bus `waitUnique()` / `emitUnique()` skip listener, buffering, and
  multi-waiter delivery paths for explicit unique-key suspension.
- API failure draining no longer uses `Array.shift()`.
- `InsereApi.applyDirectResult()` and `applyEffectResult()` now split policy
  decisions, restart fast paths, delegated policy application, and failure
  conversion into named private steps.
- Event-bus listener delivery is shared across `emit`, `publish`, and `notify`
  to avoid duplicated slot-union branching.

### Validation

- `npm run check`
- `npm run check:release`
- `npm publish --dry-run --access public`

## 0.1.0

Initial public pre-release.
