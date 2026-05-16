# Insere Throw Boundaries

Insere is Result-first at host-facing policy boundaries. Throw-oriented APIs
exist only as unsafe compatibility/command wrappers or low-level runtime
boundaries. New integration code should prefer Result APIs and use `Unsafe`
names when exceptions are intentional.

## Result Boundaries

These APIs must return `InsereResult` with structured `AppError` failures
instead of throwing policy/runtime application failures:

- `attempt(effect)`
- `applyTaskResult`
- `applyDirectTaskResult`
- `InsereApi.applyDirectResult`
- `InsereApi.applyEffectResult`
- `InsereApi.tick` and `InsereApi.runIdle` when supervision handles the failure
- `InsereHostAdapter.tick` and `InsereHostAdapter.runIdle` through the API
  facade
- supervision `convertToResult`

Expected host/domain failures should use these paths, `recover`, or explicit
host events.

## Unsafe Compatibility Wrappers

These APIs throw by design and should be treated as unsafe wrappers around the
Result form:

- `applyTaskUnsafe`
- `applyDirectTaskUnsafe`
- `InsereApi.applyDirectUnsafe`
- `InsereApi.applyEffectUnsafe`
- `InsereApi.waitFrameUnsafe`
- `InsereApi.frameLoopUnsafe`
- `InsereApiScope.applyDirectUnsafe`
- `InsereApiScope.applyEffectUnsafe`
- `InsereApiScope.waitFrameUnsafe`
- `InsereApiScope.frameLoopUnsafe`

The older boolean wrapper names remain for compatibility, but docs, examples,
benchmarks, and new host code should not introduce new calls to those names.

## Other Intentional Throw Boundaries

Throws remain intentional in these cases:

- low-level `DirectInsereTask` and `Insere` programmer errors, such as empty
  keys, duplicate `spawn`, invalid tick time, invalid sleep time, or invalid
  context access
- explicit cancellation probes via `ctx.throwIfCancelled()`
- generator `routine.throw(error)` propagation inside the effect runtime
- explicit `bubble` supervision
- explicit overflow policies configured as `"throw"`
- invalid initialization options such as non-positive buffer/logger limits
- host-owned event listeners registered through `InsereEventBus.subscribe`.
  `emit`, `emitTo`, `publish`, `publishTo`, `notify`, and `notifyTo` call
  listeners synchronously and let listener failures bubble to the host. Use
  task supervision when listener work should be reported through Insere.

Logger failures are not intentional throw boundaries. `logInsereBug` swallows
logger exceptions so logging cannot hide the task/runtime failure Result.

## Audit Command

Use this when changing failure behavior:

```sh
rg -n "throw |throw\(" src test docs
```

Each new production throw should fit one of the intentional categories above,
or the API should return `InsereResult` instead.
