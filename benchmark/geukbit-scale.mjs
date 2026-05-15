import { performance } from "node:perf_hooks";

import {
  createInsereEventBus,
  createInsereHostAdapter,
  waitBusEvent
} from "../dist/index.js";

const entityTasks = Number(process.env.GEUKBIT_ENTITY_TASKS ?? 10_000);
const scriptEvents = Number(process.env.GEUKBIT_SCRIPT_EVENTS ?? 5_000);
const gameplayEntities = Number(process.env.GEUKBIT_GAMEPLAY_ENTITIES ?? 10_000);
const physicsEntities = Number(process.env.GEUKBIT_PHYSICS_ENTITIES ?? 100_000);
const projectionRestarts = Number(process.env.GEUKBIT_PROJECTION_RESTARTS ?? 100_000);
const repeats = Number(process.env.GEUKBIT_BENCH_REPEATS ?? 9);
const gate = process.argv.includes("--gate");

let sink = 0;

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
  }).format(value);
}

function measure(name, units, run) {
  const samples = [];

  for (let index = 0; index < repeats; index += 1) {
    const start = performance.now();
    run();
    const elapsed = performance.now() - start;

    if (index > 0) {
      samples.push(elapsed);
    }
  }

  return toMeasurement(name, units, samples);
}

function measurePrepared(name, units, prepare, run) {
  const samples = [];

  for (let index = 0; index < repeats; index += 1) {
    const prepared = prepare();
    const start = performance.now();
    run(prepared);
    const elapsed = performance.now() - start;

    if (index > 0) {
      samples.push(elapsed);
    }
  }

  return toMeasurement(name, units, samples);
}

async function measureAsync(name, units, run) {
  const samples = [];

  for (let index = 0; index < repeats; index += 1) {
    const start = performance.now();
    await run();
    const elapsed = performance.now() - start;

    if (index > 0) {
      samples.push(elapsed);
    }
  }

  return toMeasurement(name, units, samples);
}

function toMeasurement(name, units, samples) {
  const bestMs = Math.min(...samples);
  const medianMs = median(samples);
  const unitsPerSecond = units / (bestMs / 1_000);
  const gateUnitsPerSecond = units / (medianMs / 1_000);

  return { name, units, bestMs, medianMs, unitsPerSecond, gateUnitsPerSecond };
}

function median(samples) {
  if (samples.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function fasterSide(insere, baseline) {
  if (!baseline) {
    return "";
  }

  if (baseline.unitsPerSecond >= insere.unitsPerSecond) {
    return `Baseline ${formatNumber(baseline.unitsPerSecond / insere.unitsPerSecond)}x`;
  }

  return `Insere ${formatNumber(insere.unitsPerSecond / baseline.unitsPerSecond)}x`;
}

function promiseEntityLifecycleCancel() {
  const tasks = new Map();

  for (let index = 0; index < entityTasks; index += 1) {
    const controller = new AbortController();
    tasks.set(`entity:${index}:script:main`, {
      controller,
      cleanup: () => {
        sink += 1;
      }
    });
  }

  for (const [key, task] of tasks) {
    if (key.startsWith("entity:")) {
      task.controller.abort();
      task.cleanup();
      tasks.delete(key);
    }
  }
}

function insereEntityLifecycleCancel() {
  const host = createInsereHostAdapter({
    dispatch: () => {
      sink += 1;
    }
  });

  for (let index = 0; index < entityTasks; index += 1) {
    host.api.applyDirect(`entity:${index}:script:main`, (ctx) => {
      ctx.onCancel(() => ctx.dispatch(index));
      ctx.waitFrame();
    });
  }

  host.api.cancelGroup("entity:");
}

async function mapScriptEventBus() {
  const waiters = new Map();
  const promises = [];

  for (let index = 0; index < scriptEvents; index += 1) {
    promises.push(new Promise((resolve) => {
      waiters.set(`entity:${index}`, (event) => {
        sink += event.entity;
        resolve();
      });
    }));
  }

  for (let index = 0; index < scriptEvents; index += 1) {
    const key = `entity:${index}`;
    const waiter = waiters.get(key);

    if (waiter) {
      waiters.delete(key);
      waiter({ entity: index });
    }
  }

  await Promise.all(promises);
}

async function insereScriptEventBus() {
  const eventBus = createInsereEventBus();
  const promises = [];

  for (let index = 0; index < scriptEvents; index += 1) {
    promises.push(eventBus.wait(`entity:${index}`).then((event) => {
      sink += event.entity;
    }));
  }

  for (let index = 0; index < scriptEvents; index += 1) {
    eventBus.emit(`entity:${index}`, { entity: index });
  }

  await Promise.all(promises);
}

function mapScriptEventCallbacks() {
  const listeners = new Map();

  for (let index = 0; index < scriptEvents; index += 1) {
    listeners.set(`entity:${index}`, (event) => {
      sink += event.entity;
    });
  }

  for (let index = 0; index < scriptEvents; index += 1) {
    listeners.get(`entity:${index}`)?.({ entity: index });
  }
}

function insereScriptEventSubscriptions() {
  const eventBus = createInsereEventBus();

  for (let index = 0; index < scriptEvents; index += 1) {
    eventBus.subscribe(`entity:${index}`, (event) => {
      sink += event.entity;
    });
  }

  for (let index = 0; index < scriptEvents; index += 1) {
    eventBus.publish(`entity:${index}`, { entity: index });
  }
}

function prepareMapScriptEventCallbacks() {
  const listeners = new Map();

  for (let index = 0; index < scriptEvents; index += 1) {
    listeners.set(`entity:${index}`, (event) => {
      sink += event.entity;
    });
  }

  return listeners;
}

function publishMapScriptEvents(listeners) {
  for (let index = 0; index < scriptEvents; index += 1) {
    listeners.get(`entity:${index}`)?.({ entity: index });
  }
}

function prepareInsereScriptEventSubscriptions() {
  const eventBus = createInsereEventBus();

  for (let index = 0; index < scriptEvents; index += 1) {
    eventBus.subscribe(`entity:${index}`, (event) => {
      sink += event.entity;
    });
  }

  return eventBus;
}

function publishInsereScriptEvents(eventBus) {
  for (let index = 0; index < scriptEvents; index += 1) {
    eventBus.notify(`entity:${index}`, { entity: index });
  }
}

async function promiseGameplayTick() {
  const frames = 3;
  let promises = [];

  for (let entity = 0; entity < gameplayEntities; entity += 1) {
    promises.push(Promise.resolve().then(() => {
      sink += 1;
    }));
  }

  for (let frame = 0; frame < frames; frame += 1) {
    await Promise.all(promises);
    promises = [];

    if (frame + 1 < frames) {
      for (let entity = 0; entity < gameplayEntities; entity += 1) {
        promises.push(Promise.resolve().then(() => {
          sink += 1;
        }));
      }
    }
  }
}

function insereGameplayTickPerEntity() {
  const frames = 3;
  const host = createInsereHostAdapter();

  for (let entity = 0; entity < gameplayEntities; entity += 1) {
    host.api.waitFrame(`gameplay:entity:${entity}`, (ctx) => {
      sink += 1;

      if (ctx.frame < frames) {
        ctx.waitFrame();
      }
    });
  }

  for (let frame = 1; frame <= frames; frame += 1) {
    host.tick(frame);
  }
}

function insereGameplaySystemTick() {
  const frames = 3;
  const host = createInsereHostAdapter();

  host.api.frameLoop("gameplay:systems", (ctx) => {
    for (let entity = 0; entity < gameplayEntities; entity += 1) {
      sink += 1;
    }

    return ctx.frame < frames;
  });

  for (let frame = 1; frame <= frames; frame += 1) {
    host.tick(frame);
  }
}

function plainPhysicsHotLoop() {
  const position = new Float64Array(physicsEntities);
  const velocity = new Float64Array(physicsEntities);
  velocity.fill(2);

  for (let frame = 0; frame < 5; frame += 1) {
    for (let entity = 0; entity < physicsEntities; entity += 1) {
      position[entity] += velocity[entity] * 0.5;
    }
  }

  sink += position[physicsEntities - 1];
}

function inserePhysicsHostTask() {
  const position = new Float64Array(physicsEntities);
  const velocity = new Float64Array(physicsEntities);
  const host = createInsereHostAdapter();
  velocity.fill(2);

  host.api.frameLoop("physics:step", (ctx) => {
    for (let entity = 0; entity < physicsEntities; entity += 1) {
      position[entity] += velocity[entity] * 0.5;
    }

    return ctx.frame < 5;
  });

  for (let frame = 1; frame <= 5; frame += 1) {
    host.tick(frame);
  }

  sink += position[physicsEntities - 1];
}

async function promiseProjectionRestart() {
  const slots = new Map();

  for (let version = 0; version < projectionRestarts; version += 1) {
    const previous = slots.get("projection:scene:main");
    if (previous) {
      previous.controller.abort();
      previous.cleanup();
    }

    const controller = new AbortController();
    const record = {
      controller,
      cleanup: () => {
        sink += 1;
      },
      version
    };
    slots.set("projection:scene:main", record);

    Promise.resolve().then(() => {
      if (
        slots.get("projection:scene:main") === record &&
        !controller.signal.aborted
      ) {
        sink += record.version;
      }
    });
  }

  await Promise.resolve();
}

function insereProjectionRestart() {
  const host = createInsereHostAdapter({
    dispatch: (event) => {
      sink += event;
    }
  });

  for (let version = 0; version < projectionRestarts; version += 1) {
    host.api.restartDirect("projection:scene:main", (ctx) => {
      if (ctx.frame === 0) {
        ctx.waitFrame();
        return;
      }

      ctx.dispatch(version);
    });
  }

  host.tick(1);
}

const rows = [
  {
    scenario: "per-entity lifecycle cancel",
    baseline: measure("Promise Map+Abort cancel", entityTasks, promiseEntityLifecycleCancel),
    insere: measure("Insere cancelGroup", entityTasks, insereEntityLifecycleCancel)
  },
  {
    scenario: "script event bus targeted",
    baseline: await measureAsync("Map keyed Promise bus", scriptEvents, mapScriptEventBus),
    insere: await measureAsync("InsereEventBus", scriptEvents, insereScriptEventBus)
  },
  {
    scenario: "script event bus direct callbacks setup+publish",
    baseline: measure("Map keyed callbacks", scriptEvents, mapScriptEventCallbacks),
    insere: measure("InsereEventBus publish", scriptEvents, insereScriptEventSubscriptions)
  },
  {
    scenario: "script event bus direct callbacks publish-only",
    baseline: measurePrepared(
      "Map keyed callbacks hot publish",
      scriptEvents,
      prepareMapScriptEventCallbacks,
      publishMapScriptEvents
    ),
    insere: measurePrepared(
      "InsereEventBus hot publish",
      scriptEvents,
      prepareInsereScriptEventSubscriptions,
      publishInsereScriptEvents
    )
  },
  {
    scenario: "gameplay tick per-entity tasks (discouraged)",
    baseline: await measureAsync("Promise microtask gameplay", gameplayEntities * 3, promiseGameplayTick),
    insere: measure("Insere per-entity direct gameplay", gameplayEntities * 3, insereGameplayTickPerEntity)
  },
  {
    scenario: "gameplay tick system task",
    baseline: await measureAsync("Promise microtask gameplay", gameplayEntities * 3, promiseGameplayTick),
    insere: measure("Insere frameLoop gameplay system", gameplayEntities * 3, insereGameplaySystemTick)
  },
  {
    scenario: "physics/animation hot loop",
    baseline: measure("Plain TS hot loop", physicsEntities * 5, plainPhysicsHotLoop),
    insere: measure("One Insere host task", physicsEntities * 5, inserePhysicsHostTask)
  },
  {
    scenario: "runtime projection restart",
    baseline: await measureAsync("Promise latest-only projection", projectionRestarts, promiseProjectionRestart),
    insere: measure("Insere restartDirect projection", projectionRestarts, insereProjectionRestart)
  }
];

console.log("# Geukbit scale benchmark");
console.log("");
console.log(`Node: ${process.version}`);
console.log(`Repeats: ${repeats} (best of ${repeats - 1} after warmup)`);
console.log("");
console.log("| Scenario | Baseline | Insere | Baseline units/s | Insere units/s | Insere best ms | Faster side |");
console.log("| --- | --- | --- | ---: | ---: | ---: | ---: |");

for (const row of rows) {
  console.log(
    `| ${row.scenario} | ${row.baseline.name} | ${row.insere.name} | ` +
      `${formatNumber(row.baseline.unitsPerSecond)} | ` +
      `${formatNumber(row.insere.unitsPerSecond)} | ` +
      `${formatNumber(row.insere.bestMs)} | ` +
      `${fasterSide(row.insere, row.baseline)} |`
  );
}

console.log("");
console.log(`sink=${sink}`);

if (gate) {
  assertInsereFaster("per-entity lifecycle cancel", 1.5);
  assertInsereFaster("gameplay tick system task", 2);
  assertInsereFaster("runtime projection restart", 2);
  assertNotSlowerThan("script event bus direct callbacks publish-only", 0.5);
  assertNotSlowerThan("physics/animation hot loop", 0.5);
}

function assertInsereFaster(scenario, minRatio) {
  const row = rows.find((item) => item.scenario === scenario);

  if (!row) {
    throw new Error(`Missing Geukbit benchmark scenario: ${scenario}`);
  }

  const ratio = row.insere.gateUnitsPerSecond / row.baseline.gateUnitsPerSecond;

  if (ratio < minRatio) {
    throw new Error(
      `${scenario} median gate failed: Insere ${formatNumber(ratio)}x, expected >= ${minRatio}x.`
    );
  }
}

function assertNotSlowerThan(scenario, minRatio) {
  const row = rows.find((item) => item.scenario === scenario);

  if (!row) {
    throw new Error(`Missing Geukbit benchmark scenario: ${scenario}`);
  }

  const ratio = row.insere.gateUnitsPerSecond / row.baseline.gateUnitsPerSecond;

  if (ratio < minRatio) {
    throw new Error(
      `${scenario} median gate failed: Insere ${formatNumber(ratio)}x baseline, expected >= ${minRatio}x.`
    );
  }
}
