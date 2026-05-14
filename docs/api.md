# Insere API Design

`@exornea/insere/api` is the recommended host-facing entry point.

The root package still exports the lower-level building blocks, but application
adapters should usually start from the API facade:

```ts
import { createInsereApi } from "@exornea/insere/api";

const api = createInsereApi({ dispatch, getState });
const editor = api.scope("editor");

editor.applyDirect("preview", updatePreview, "restart", "frame");
editor.applyEffectResult("autosave", autosaveEffect, "skip");

api.tick(performance.now());
```

## Goals

- Keep direct tasks and generator effects on one host clock.
- Keep direct tasks and generator effects in one key space.
- Keep policy semantics identical across direct and effect work.
- Return Result reports for host adapters that should avoid policy exceptions.
- Keep hot direct paths available without forcing effect/generator overhead.

## Layers

```txt
@exornea/insere/api
  InsereApi
    direct: DirectInsereTask
    effect: Insere
  InsereApiScope
    direct: DirectInsereTaskScope
    effect: InsereTaskScope
```

`InsereApi` owns both runtimes. `tick(now)` advances direct tasks first, then
effect routines. `runIdle()` pumps both idle queues. `cancel`, `cancelGroup`,
and `cancelAll` apply to both runtimes.

`InsereApiScope` builds prefixed keys and returns filtered snapshots across
both runtimes.

`api.direct`, `api.effect`, `scope.direct`, and `scope.effect` are exposed as
escape hatches. Calling them directly bypasses the facade's shared-key policy.
Host adapters that need one logical key space should use `InsereApi` and
`InsereApiScope` methods for task application and cancellation.

## Policy

Policy meanings are shared:

- `restart`: supersede existing work at the same key.
- `spawn`: start only when the key is free; duplicate keys become `err(error)`
  in Result APIs and throw in boolean APIs.
- `skip`: start only when the key is free; active keys return
  `ok({ applied: false, status: "skipped" })`.

Boolean methods exist for ergonomic command paths:

```ts
api.applyDirect("drag:preview", step, "restart", "frame");
api.applyEffect("autosave", effect, "skip");
```

Result methods exist for host adapters:

```ts
const result = api.applyDirectResult("autosave", step, "skip", "frame");
```

The Result value shape is shared:

```ts
type InsereTaskApplyResult = InsereResult<{
  key: string;
  policy: "spawn" | "restart" | "skip";
  applied: boolean;
  status: "started" | "restarted" | "skipped";
}, unknown>;
```

## Choosing Direct vs Effect

Use direct work for hot orchestration:

- projection rebuild supersession
- drag preview frame continuation
- autosave slots
- asset preview restart
- scene-switch cancellation

Use effect work for expressive composition:

- Promise bridges
- `attempt` / `recover`
- resource lifecycle helpers
- sequential workflows
- reusable effect declarations

The facade keeps both available without forcing one model into the other.
