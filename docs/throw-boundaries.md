# Insere Throw Boundaries

Insere has both Result-returning APIs and throw-oriented convenience/runtime
APIs. The goal is not to remove every `throw`; the goal is to make each throw
boundary intentional and documented.

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

## Intentional Throw Boundaries

Throws remain intentional in these cases:

- boolean convenience APIs such as `applyTask`, `applyDirectTask`,
  `api.applyDirect`, and `api.applyEffect`
- low-level `DirectInsereTask` and `Insere` programmer errors, such as empty
  keys, duplicate `spawn`, invalid tick time, invalid sleep time, or invalid
  context access
- cancellation injected into a running direct task or generator routine
- generator `routine.throw(error)` propagation inside the effect runtime
- default `bubble` supervision and exhausted bounded `restart` supervision
- explicit overflow policies configured as `"throw"`
- invalid initialization options such as non-positive buffer/logger limits
- host-owned event listeners registered through `InsereEventBus.subscribe`.
  `emit`, `emitTo`, `publish`, and `publishTo` call listeners synchronously and
  let listener failures bubble to the host. Use task supervision when listener
  work should be reported through Insere.

Logger failures are not intentional throw boundaries. `logInsereBug` swallows
logger exceptions so logging cannot hide the original task/runtime failure.

## Audit Command

Use this when changing failure behavior:

```sh
rg -n "throw |throw\(" src test docs
```

Each new production throw should fit one of the intentional categories above,
or the API should return `InsereResult` instead.
