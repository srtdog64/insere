import { performance } from "node:perf_hooks";

import { DirectInsereTask } from "../dist/index.js";

const iterations = Number(process.env.INSERE_BENCH_RESTARTS ?? 100_000);
const repeats = Number(process.env.INSERE_RESTART_REPEATS ?? 31);
const gate = process.argv.includes("--gate");

const minMedianRatio = Number(process.env.INSERE_RESTART_MIN_RATIO ?? 2);
const maxMedianMs = Number(process.env.INSERE_RESTART_MAX_MEDIAN_MS ?? 30);
const maxP75Ms = Number(process.env.INSERE_RESTART_MAX_P75_MS ?? 40);

let sink = 0;

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2
  }).format(value);
}

async function measureAsync(name, run) {
  const samples = [];

  for (let index = 0; index < repeats; index += 1) {
    const start = performance.now();
    await run(iterations);
    const elapsed = performance.now() - start;

    if (index > 0) {
      samples.push(elapsed);
    }
  }

  return toMeasurement(name, samples);
}

function measure(name, run) {
  const samples = [];

  for (let index = 0; index < repeats; index += 1) {
    const start = performance.now();
    run(iterations);
    const elapsed = performance.now() - start;

    if (index > 0) {
      samples.push(elapsed);
    }
  }

  return toMeasurement(name, samples);
}

function toMeasurement(name, samples) {
  const sortedSamples = [...samples].sort((left, right) => left - right);
  const bestMs = sortedSamples[0] ?? Number.POSITIVE_INFINITY;
  const medianMs = percentileSorted(sortedSamples, 0.5);
  const p75Ms = percentileSorted(sortedSamples, 0.75);
  const p90Ms = percentileSorted(sortedSamples, 0.9);

  return {
    name,
    bestMs,
    medianMs,
    p75Ms,
    p90Ms,
    samples,
    opsPerSecond: iterations / (bestMs / 1_000),
    gateOpsPerSecond: iterations / (medianMs / 1_000)
  };
}

function percentileSorted(samples, percentile) {
  if (samples.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  const index = Math.min(
    samples.length - 1,
    Math.max(0, Math.ceil(samples.length * percentile) - 1)
  );

  return samples[index] ?? Number.POSITIVE_INFINITY;
}

async function promiseLatestOnlyRestart(count) {
  const slots = new Map();

  for (let index = 0; index < count; index += 1) {
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

function directLatestOnlyRestart(count) {
  const runtime = new DirectInsereTask({
    dispatch: (value) => {
      sink += value;
    }
  });

  for (let index = 0; index < count; index += 1) {
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

const baseline = await measureAsync("Promise+Map+Abort latest-only", promiseLatestOnlyRestart);
const insere = measure("DirectInsereTask restart", directLatestOnlyRestart);
const medianRatio = insere.gateOpsPerSecond / baseline.gateOpsPerSecond;

console.log("# Restart storm sustained watch");
console.log("");
console.log(`Node: ${process.version}`);
console.log(`Iterations: ${formatNumber(iterations)}`);
console.log(`Repeats: ${repeats} (best/median/p75/p90 of ${repeats - 1} after warmup)`);
console.log("");
console.log("| Scenario | ops/s best | median ms | p75 ms | p90 ms | samples ms |");
console.log("| --- | ---: | ---: | ---: | ---: | --- |");
printMeasurement(baseline);
printMeasurement(insere);
console.log("");
console.log(`median ratio: Insere ${formatNumber(medianRatio)}x`);
console.log(`sink=${sink}`);

if (gate) {
  const failures = [];

  if (medianRatio < minMedianRatio) {
    failures.push(
      `median ratio ${formatNumber(medianRatio)}x < ${formatNumber(minMedianRatio)}x`
    );
  }

  if (insere.medianMs > maxMedianMs) {
    failures.push(
      `Insere median ${formatNumber(insere.medianMs)}ms > ${formatNumber(maxMedianMs)}ms`
    );
  }

  if (insere.p75Ms > maxP75Ms) {
    failures.push(
      `Insere p75 ${formatNumber(insere.p75Ms)}ms > ${formatNumber(maxP75Ms)}ms`
    );
  }

  if (failures.length > 0) {
    throw new Error(
      "Restart storm sustained regression gate failed:\n" +
      failures.map((failure) => `- ${failure}`).join("\n") +
      "\n" +
      `baseline samples ms: ${formatSamples(baseline.samples)}\n` +
      `insere samples ms: ${formatSamples(insere.samples)}`
    );
  }
}

function printMeasurement(measurement) {
  console.log(
    `| ${measurement.name} | ` +
      `${formatNumber(measurement.opsPerSecond)} | ` +
      `${formatNumber(measurement.medianMs)} | ` +
      `${formatNumber(measurement.p75Ms)} | ` +
      `${formatNumber(measurement.p90Ms)} | ` +
      `${formatSamples(measurement.samples)} |`
  );
}

function formatSamples(samples) {
  return `[${samples.map((sample) => formatNumber(sample)).join(", ")}]`;
}
