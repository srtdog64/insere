# Insere Stability

Insere `0.1.0` is a public pre-release. The package is usable for dogfood, but
the API is not declared stable yet.

## Package Boundary

Insere should stay a generic host-cooperative scheduler. Domain adapters belong
in host applications.

Allowed in Insere:

- keyed direct and effect scheduling
- `frameLoop` system loops
- cancellation and `cancelGroup`
- mailbox and keyed event-bus primitives
- Result, policy, supervision, and structured logging
- host hooks such as `dispatch`, `getState`, `requestId`, and `logger`
- benchmarks and release gates

Not allowed in Insere:

- document, workspace, user, cursor, selection, entity, projection, presence,
  undo/redo, CRDT, or OT semantics
- canvas-specific coalescing policy
- product-specific key naming
- application lifecycle adapters

Those belong in the host repository that owns the domain.

## Public Entrypoints

The root entrypoint exports the full surface:

```ts
import { createInsereHostAdapter } from "@exornea/insere";
```

Subpath entrypoints are provided for callers that want a narrower import:

```ts
import { createInsereApi } from "@exornea/insere/api";
import { DirectInsereTask } from "@exornea/insere/core";
import { ok } from "@exornea/insere/effect";
import { createInsereEventBus } from "@exornea/insere/event-bus";
import { createInsereHostAdapter } from "@exornea/insere/host";
import { createConsoleInsereLogger } from "@exornea/insere/logging";
import { createInsereMailbox } from "@exornea/insere/mailbox";
import { normalizeInsereSupervision } from "@exornea/insere/supervision";
import { directFrameTask } from "@exornea/insere/task";
```

`scripts/smoke-exports.mjs` verifies these entrypoints from built `dist`
artifacts before packing or publishing.

## Release Gates

Normal local validation:

```sh
npm run check
```

Release-candidate validation:

```sh
npm run check:release
```

`check:release` includes benchmark gates. Benchmarks are not exact product
latency models, so the gates use conservative ratios instead of exact timings.

Required P0 ratios:

- restart storm: Insere at least `2x` faster than Promise+Map+Abort
- frame continuation: Insere at least `1.2x` faster than Promise frame steps
- cancel group: Insere at least `2x` faster than Map+AbortController
- mixed cancel group: Insere at least `2x` faster than Map+AbortController

Required Geukbit-scale ratios:

- lifecycle cancel: Insere at least `1.5x` faster
- gameplay system `frameLoop`: Insere at least `2x` faster
- projection restart: Insere at least `2x` faster
- hot event publish-only and physics host-task paths must remain at least
  `0.5x` of their raw baseline, because those are near-plain-TypeScript
  comparison points.

## Compatibility Rules

Before `1.0`, small API changes are allowed, but release candidates should
avoid breaking these surfaces without an explicit version note:

- package subpath names
- `InsereResult` and `AppError` shape
- task policy names: `spawn`, `restart`, `skip`
- supervision policy names
- direct context methods
- mailbox and event-bus buffering policy names

Performance regressions should be treated as breaking for the P0 paths even
when TypeScript types still compile.
