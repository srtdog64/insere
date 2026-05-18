# Scheduler Atomicity

Insere is single-threaded by design. It is a host-cooperative scheduler, not a
worker runtime. The core assumes the JavaScript event loop memory model: one
caller is executing an API method at a time, and work advances only when the
host calls `tick(now)`, `runIdle()`, or an explicit spawn/restart/cancel API.

This means Insere does not need locks, mutexes, atomics, or shared-memory
coordination inside the scheduler. Worker threads, CPU pools, rendering
threads, and I/O execution belong to host adapters.

## Atomic Unit

Each public scheduler method is synchronous. From the host's point of view,
these calls commit before returning:

- `spawn`
- `restart`
- `cancel`
- `cancelGroup`
- `cancelAll`
- `tick`
- `runIdle`
- API facade equivalents such as `applyDirectResult`, `applyEffectResult`,
  `tick`, and `runIdle`

The scheduler does not preempt a running JavaScript callback. A task can only be
interrupted at normal JavaScript call boundaries or by explicit host
reentrancy.

## Reentrancy Model

Reentrancy is allowed but intentionally narrow. A running task may call back
into the scheduler through captured host APIs:

```txt
tick()
  task A runs
    restart("projection", task B)
    cancelGroup("asset:")
  task iteration continues
```

The contract is:

- reentrant `restart(key, ...)` supersedes the currently active occupant of the
  key immediately
- the previous routine/step cannot commit a later wait state over the new
  occupant after it resumes
- reentrant `cancel`, `cancelGroup`, and `cancelAll` remove matching entries
  immediately
- frame queues tolerate mutation while they are being drained
- task failures stay isolated unless the API facade is configured with
  explicit `bubble` supervision

This is not transaction isolation. `tick()` is allowed to observe the effects
of reentrant scheduler calls made by tasks it is currently running. The
guarantee is slot safety: removed or superseded entries must not resurrect
themselves or delete/overwrite a newer occupant.

## Self-Restart Rule

Self-restart is legal but should be treated as terminal for the current
routine/step:

```ts
api.applyDirectResult("projection:scene", (ctx) => {
  if (needsFullRestart) {
    api.applyDirectResult("projection:scene", nextProjectionStep, "restart");
    return;
  }

  ctx.waitFrame();
}, "restart");
```

After a task supersedes its own key, old code should return. Direct context
methods are only valid while the original step is active. The runtime also
guards against stale commits so a yielded instruction from the previous
generator routine cannot overwrite the replacement routine's wait state.

## Worker Boundary

If a host uses Web Workers or Node worker threads, keep Insere on the host
thread and make the worker boundary explicit:

```txt
host thread
  Insere scheduler
  keyed lifecycle
  cancel/restart/latest-only policy

worker
  heavy CPU work
  parsing, baking, geometry, asset transforms

boundary
  requestId
  task key
  cancel message or AbortSignal convention
  Result payload
  stale-result guard
```

Worker results must be checked against the current key/request identity before
being applied. That stale-result guard is a host adapter responsibility, not a
hidden scheduler feature.

## Tests To Preserve

Do not remove the reentrancy tests that cover:

- frame-queue mutation while draining
- reentrant `cancelGroup` during frame continuation
- direct self-restart not deleting or overwriting the replacement step
- effect self-restart not letting the previous yielded instruction delay the
  replacement routine

Those tests define the scheduler atomicity floor for `0.2.x`.
