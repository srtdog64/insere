import { performance } from "node:perf_hooks";

import {
  DirectInsereTask,
  Insere,
  frame,
  matchResult,
  ok
} from "../dist/index.js";

const restartIterations = Number(process.env.INSERE_BENCH_RESTARTS ?? 100_000);
const frameTasks = Number(process.env.INSERE_BENCH_FRAME_TASKS ?? 10_000);
const cancelTasks = Number(process.env.INSERE_BENCH_CANCEL_TASKS ?? 10_000);
const resultIterations = Number(process.env.INSERE_BENCH_RESULTS ?? 1_000_000);
const repeats = Number(process.env.INSERE_BENCH_REPEATS ?? 11);

let sink = 0;

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
  }).format(value);
}

function measure(name, iterations, run) {
  const samples = [];

  for (let index = 0; index < repeats; index += 1) {
    const start = performance.now();
    run(iterations);
    const elapsed = performance.now() - start;

    if (index > 0) {
      samples.push(elapsed);
    }
  }

  return toMeasurement(name, iterations, samples);
}

async function measureAsync(name, iterations, run) {
  const samples = [];

  for (let index = 0; index < repeats; index += 1) {
    const start = performance.now();
    await run(iterations);
    const elapsed = performance.now() - start;

    if (index > 0) {
      samples.push(elapsed);
    }
  }

  return toMeasurement(name, iterations, samples);
}

async function measurePreparedAsync(name, iterations, setup, run) {
  const samples = [];

  for (let index = 0; index < repeats; index += 1) {
    const prepared = setup(iterations);
    const start = performance.now();
    await run(prepared);
    const elapsed = performance.now() - start;

    if (index > 0) {
      samples.push(elapsed);
    }
  }

  return toMeasurement(name, iterations, samples);
}

function measurePrepared(name, iterations, setup, run) {
  const samples = [];

  for (let index = 0; index < repeats; index += 1) {
    const prepared = setup(iterations);
    const start = performance.now();
    run(prepared);
    const elapsed = performance.now() - start;

    if (index > 0) {
      samples.push(elapsed);
    }
  }

  return toMeasurement(name, iterations, samples);
}

function toMeasurement(name, iterations, samples) {
  const bestMs = Math.min(...samples);
  const opsPerSecond = iterations / (bestMs / 1_000);

  return { name, iterations, bestMs, opsPerSecond };
}

function fasterSide(insere, baseline) {
  if (baseline.opsPerSecond >= insere.opsPerSecond) {
    return `Baseline ${formatNumber(baseline.opsPerSecond / insere.opsPerSecond)}x`;
  }

  return `Insere ${formatNumber(insere.opsPerSecond / baseline.opsPerSecond)}x`;
}

async function promiseLatestOnlyRestart(iterations) {
  const slots = new Map();

  for (let index = 0; index < iterations; index += 1) {
    const previous = slots.get("projection");
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
      value: index
    };
    slots.set("projection", record);

    Promise.resolve().then(() => {
      if (slots.get("projection") === record && !controller.signal.aborted) {
        sink += record.value;
        slots.delete("projection");
      }
    });
  }

  await Promise.resolve();
}

function directLatestOnlyRestart(iterations) {
  const runtime = new DirectInsereTask({
    dispatch: (value) => {
      sink += value;
    }
  });

  for (let index = 0; index < iterations; index += 1) {
    runtime.restart("projection", (ctx) => {
      if (ctx.frame === 0) {
        ctx.waitFrame();
        return;
      }

      ctx.dispatch(index);
      ctx.complete();
    });
  }

  runtime.tick(1);
}

function setupPromiseFrameContinuation(iterations) {
  const tasks = [];

  for (let index = 0; index < iterations; index += 1) {
    tasks.push((async () => {
      await Promise.resolve();
      sink += 1;
    })());
  }

  return Promise.all(tasks);
}

async function promiseFrameContinuation(promise) {
  await promise;
}

function setupDirectFrameContinuation(iterations) {
  const runtime = new DirectInsereTask();

  for (let index = 0; index < iterations; index += 1) {
    runtime.waitFrame(`task:${index}`, () => {
      sink += 1;
    });
  }

  return runtime;
}

function directFrameContinuation(runtime) {
  runtime.tick(1);
}

function setupPromiseCancelGroup(iterations) {
  const tasks = new Map();

  for (let index = 0; index < iterations; index += 1) {
    const controller = new AbortController();
    tasks.set(`asset:${index}`, {
      controller,
      cleanup: () => {
        sink += 1;
      }
    });
  }

  return tasks;
}

function promiseCancelGroup(tasks) {
  for (const [key, task] of tasks) {
    if (key.startsWith("asset:")) {
      task.controller.abort();
      task.cleanup();
      tasks.delete(key);
    }
  }
}

function setupPromiseMixedCancelGroup(iterations) {
  const tasks = new Map();
  const half = Math.floor(iterations / 2);

  for (let index = 0; index < half; index += 1) {
    const controller = new AbortController();
    tasks.set(`asset:${index}`, {
      controller,
      cleanup: () => {
        sink += 1;
      }
    });
  }

  for (let index = half; index < iterations; index += 1) {
    const controller = new AbortController();
    tasks.set(`preview:${index}`, {
      controller,
      cleanup: () => {
        sink += 1;
      }
    });
  }

  return tasks;
}

function setupDirectCancelGroup(iterations) {
  const runtime = new DirectInsereTask({
    dispatch: () => {
      sink += 1;
    }
  });

  for (let index = 0; index < iterations; index += 1) {
    runtime.spawn(`asset:${index}`, (ctx) => {
      ctx.onCancel(() => ctx.dispatch(index));
      ctx.waitFrame();
    });
  }

  return runtime;
}

function directCancelGroup(runtime) {
  runtime.cancelGroup("asset:");
}

function setupDirectMixedCancelGroup(iterations) {
  const runtime = new DirectInsereTask({
    dispatch: () => {
      sink += 1;
    }
  });
  const half = Math.floor(iterations / 2);

  for (let index = 0; index < half; index += 1) {
    runtime.spawn(`asset:${index}`, (ctx) => {
      ctx.onCancel(() => ctx.dispatch(index));
      ctx.waitFrame();
    });
  }

  for (let index = half; index < iterations; index += 1) {
    runtime.spawn(`preview:${index}`, (ctx) => {
      ctx.onCancel(() => ctx.dispatch(index));
      ctx.waitFrame();
    });
  }

  return runtime;
}

function generatorFrameLoop(iterations) {
  const runtime = new Insere({
    dispatch: () => {
      sink += 1;
    }
  });

  runtime.restart("frame-loop", function* (ctx) {
    for (let index = 0; index < iterations; index += 1) {
      yield frame();
      ctx.dispatch(index);
    }
  });

  for (let index = 0; index < iterations; index += 1) {
    runtime.tick(index);
  }
}

function resultBranch(iterations) {
  for (let index = 0; index < iterations; index += 1) {
    sink += matchResult(
      ok(index),
      (value) => value,
      () => 0
    );
  }
}

function directBranch(iterations) {
  for (let index = 0; index < iterations; index += 1) {
    sink += index;
  }
}

const promiseRestart = await measureAsync(
  "Promise+Map+Abort latest-only",
  restartIterations,
  promiseLatestOnlyRestart
);
const directRestart = measure(
  "DirectInsereTask restart",
  restartIterations,
  directLatestOnlyRestart
);
const promiseFrames = await measurePreparedAsync(
  "async/await Promise frame step",
  frameTasks,
  setupPromiseFrameContinuation,
  promiseFrameContinuation
);
const directFrames = measurePrepared(
  "DirectInsereTask waitFrame tick",
  frameTasks,
  setupDirectFrameContinuation,
  directFrameContinuation
);
const promiseCancel = measurePrepared(
  "Map+AbortController cancelGroup",
  cancelTasks,
  setupPromiseCancelGroup,
  promiseCancelGroup
);
const directCancel = measurePrepared(
  "DirectInsereTask cancelGroup",
  cancelTasks,
  setupDirectCancelGroup,
  directCancelGroup
);
const promiseMixedCancel = measurePrepared(
  "Map+AbortController mixed cancelGroup",
  cancelTasks,
  setupPromiseMixedCancelGroup,
  promiseCancelGroup
);
const directMixedCancel = measurePrepared(
  "DirectInsereTask indexed mixed cancelGroup",
  cancelTasks,
  setupDirectMixedCancelGroup,
  directCancelGroup
);
const generatorFrames = measure(
  "Generator Insere frame routine",
  restartIterations,
  generatorFrameLoop
);
const directValue = measure(
  "Direct TS value branch",
  resultIterations,
  directBranch
);
const resultValue = measure(
  "InsereResult ok/match",
  resultIterations,
  resultBranch
);

const p0Rows = [
  {
    scenario: "Restart storm",
    baseline: promiseRestart,
    insere: directRestart
  },
  {
    scenario: "Frame continuation",
    baseline: promiseFrames,
    insere: directFrames
  },
  {
    scenario: "Cancel group",
    baseline: promiseCancel,
    insere: directCancel
  },
  {
    scenario: "Cancel group mixed",
    baseline: promiseMixedCancel,
    insere: directMixedCancel
  }
];

const referenceRows = [
  {
    scenario: "Generator frame routine",
    baseline: promiseFrames,
    insere: generatorFrames
  },
  {
    scenario: "Result branch",
    baseline: directValue,
    insere: resultValue
  }
];

console.log("# Insere benchmark");
console.log("");
console.log(`Node: ${process.version}`);
console.log(`Repeats: ${repeats} (best of ${repeats - 1} after warmup)`);
console.log("");
printTable("P0 targets", p0Rows);
console.log("");
printTable("Reference checks", referenceRows);
console.log("");
console.log(`sink=${sink}`);

function printTable(title, rows) {
  console.log(`## ${title}`);
  console.log("");
  console.log("| Scenario | Baseline | Insere | Baseline ops/s | Insere ops/s | Best ms | Faster side |");
  console.log("| --- | --- | --- | ---: | ---: | ---: | ---: |");

  for (const row of rows) {
    console.log(
      `| ${row.scenario} | ${row.baseline.name} | ${row.insere.name} | ` +
        `${formatNumber(row.baseline.opsPerSecond)} | ` +
        `${formatNumber(row.insere.opsPerSecond)} | ` +
        `${formatNumber(row.insere.bestMs)} | ` +
        `${fasterSide(row.insere, row.baseline)} |`
    );
  }
}
