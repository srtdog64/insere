import {
  delay as delayInstruction,
  frame as frameInstruction,
  fromPromise,
  idle as idleInstruction,
  type InsereInstruction
} from "./instruction.js";
import type { InsereContext, InsereRoutineFactory } from "./runtime.js";

export type InsereEffectRoutine<TValue> = Generator<
  InsereInstruction,
  TValue,
  unknown
>;

export type InsereEffect<
  TState = unknown,
  TEvent = unknown,
  TValue = void
> = (context: InsereContext<TState, TEvent>) => InsereEffectRoutine<TValue>;

export type InsereResult<TValue, TError = unknown> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: TError };

export function ok<TValue>(value: TValue): InsereResult<TValue, never> {
  return { ok: true, value };
}

export function err<TError>(error: TError): InsereResult<never, TError> {
  return { ok: false, error };
}

export function isOk<TValue, TError>(
  result: InsereResult<TValue, TError>
): result is { readonly ok: true; readonly value: TValue } {
  return result.ok;
}

export function isErr<TValue, TError>(
  result: InsereResult<TValue, TError>
): result is { readonly ok: false; readonly error: TError } {
  return !result.ok;
}

export function matchResult<TValue, TError, TNext>(
  result: InsereResult<TValue, TError>,
  cases: {
    readonly ok: (value: TValue) => TNext;
    readonly err: (error: TError) => TNext;
  }
): TNext;
export function matchResult<TValue, TError, TNext>(
  result: InsereResult<TValue, TError>,
  onOk: (value: TValue) => TNext,
  onErr: (error: TError) => TNext
): TNext;
export function matchResult<TValue, TError, TNext>(
  result: InsereResult<TValue, TError>,
  casesOrOnOk:
    | {
        readonly ok: (value: TValue) => TNext;
        readonly err: (error: TError) => TNext;
      }
    | ((value: TValue) => TNext),
  onErr?: (error: TError) => TNext
): TNext {
  if (typeof casesOrOnOk === "function") {
    return result.ok
      ? casesOrOnOk(result.value)
      : (onErr as (error: TError) => TNext)(result.error);
  }

  return result.ok
    ? casesOrOnOk.ok(result.value)
    : casesOrOnOk.err(result.error);
}

export function effect<TState, TEvent, TValue>(
  factory: InsereEffect<TState, TEvent, TValue>
): InsereEffect<TState, TEvent, TValue> {
  return factory;
}

export function succeed<TValue>(
  value: TValue
): InsereEffect<unknown, unknown, TValue> {
  return function* () {
    return value;
  };
}

export function sync<TValue>(
  run: () => TValue
): InsereEffect<unknown, unknown, TValue> {
  return function* () {
    return run();
  };
}

export function asyncEffect<TState, TEvent, TValue>(
  run: (context: InsereContext<TState, TEvent>) => Promise<TValue>
): InsereEffect<TState, TEvent, TValue> {
  return function* (context) {
    context.throwIfCancelled();
    const value = (yield fromPromise(run(context))) as TValue;
    context.throwIfCancelled();
    return value;
  };
}

export function abortable<TState, TEvent, TValue>(
  run: (
    signal: AbortSignal,
    context: InsereContext<TState, TEvent>
  ) => Promise<TValue>
): InsereEffect<TState, TEvent, TValue> {
  return asyncEffect((context) => run(context.signal, context));
}

export function fail(error: unknown): InsereEffect<unknown, unknown, never> {
  return function* () {
    throw error;
  };
}

export function currentFrame(): InsereEffect<unknown, unknown, number> {
  return function* (context) {
    return context.frame;
  };
}

export function currentKey(): InsereEffect<unknown, unknown, string> {
  return function* (context) {
    return context.key;
  };
}

export function currentTime(): InsereEffect<unknown, unknown, number> {
  return function* (context) {
    return context.now;
  };
}

export function currentDelta(): InsereEffect<unknown, unknown, number> {
  return function* (context) {
    return context.delta;
  };
}

export function getState<TState>(): InsereEffect<TState, unknown, TState> {
  return function* (context) {
    return context.getState();
  };
}

export function access<TState, TValue>(
  project: (state: TState) => TValue
): InsereEffect<TState, unknown, TValue> {
  return function* (context) {
    return project(context.getState());
  };
}

export function dispatch<TEvent>(
  event: TEvent
): InsereEffect<unknown, TEvent, void> {
  return function* (context) {
    context.dispatch(event);
  };
}

export function checkCancellation(): InsereEffect<unknown, unknown, void> {
  return function* (context) {
    context.throwIfCancelled();
  };
}

export function onCancel<TState, TEvent>(
  cleanup: (context: InsereContext<TState, TEvent>) => void
): InsereEffect<TState, TEvent, () => void> {
  return function* (context) {
    return context.onCancel(() => cleanup(context));
  };
}

export function waitFrame(): InsereEffect<unknown, unknown, void> {
  return function* () {
    yield frameInstruction();
  };
}

export function waitFrames(count: number): InsereEffect<unknown, unknown, void> {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`Invalid frame count: ${count}`);
  }

  return function* () {
    for (let index = 0; index < count; index += 1) {
      yield frameInstruction();
    }
  };
}

export function waitIdle(): InsereEffect<unknown, unknown, void> {
  return function* () {
    yield idleInstruction();
  };
}

export function sleep(ms: number): InsereEffect<unknown, unknown, void> {
  return function* () {
    yield delayInstruction(ms);
  };
}

export function sleepUntil(time: number): InsereEffect<unknown, unknown, void> {
  if (!Number.isFinite(time)) {
    throw new RangeError(`Invalid wake time: ${time}`);
  }

  return function* (context) {
    yield delayInstruction(Math.max(0, time - context.now));
  };
}

export function awaitPromise<TValue>(
  promise: Promise<TValue>
): InsereEffect<unknown, unknown, TValue> {
  return function* () {
    return (yield fromPromise(promise)) as TValue;
  };
}

export function map<TState, TEvent, TValue, TNext>(
  source: InsereEffect<TState, TEvent, TValue>,
  project: (value: TValue) => TNext
): InsereEffect<TState, TEvent, TNext> {
  return function* (context) {
    return project(yield* source(context));
  };
}

export function tap<TState, TEvent, TValue>(
  source: InsereEffect<TState, TEvent, TValue>,
  sideEffect: (value: TValue) => InsereEffect<TState, TEvent, unknown>
): InsereEffect<TState, TEvent, TValue> {
  return function* (context) {
    const value = yield* source(context);
    yield* sideEffect(value)(context);
    return value;
  };
}

export function flatMap<TState, TEvent, TValue, TNext>(
  source: InsereEffect<TState, TEvent, TValue>,
  project: (value: TValue) => InsereEffect<TState, TEvent, TNext>
): InsereEffect<TState, TEvent, TNext> {
  return function* (context) {
    return yield* project(yield* source(context))(context);
  };
}

export function attempt<TState, TEvent, TValue>(
  source: InsereEffect<TState, TEvent, TValue>
): InsereEffect<TState, TEvent, InsereResult<TValue>> {
  return function* (context) {
    try {
      return ok(yield* source(context));
    } catch (error) {
      return err(error);
    }
  };
}

export function recover<TState, TEvent, TValue>(
  source: InsereEffect<TState, TEvent, TValue>,
  fallback: (error: unknown) => InsereEffect<TState, TEvent, TValue>
): InsereEffect<TState, TEvent, TValue> {
  return function* (context) {
    try {
      return yield* source(context);
    } catch (error) {
      return yield* fallback(error)(context);
    }
  };
}

export function ensuring<TState, TEvent, TValue>(
  source: InsereEffect<TState, TEvent, TValue>,
  finalizer: InsereEffect<TState, TEvent, unknown>
): InsereEffect<TState, TEvent, TValue> {
  return function* (context) {
    try {
      return yield* source(context);
    } finally {
      yield* finalizer(context);
    }
  };
}

export function acquireUseRelease<TState, TEvent, TResource, TValue>(
  acquire: InsereEffect<TState, TEvent, TResource>,
  use: (resource: TResource) => InsereEffect<TState, TEvent, TValue>,
  release: (resource: TResource) => InsereEffect<TState, TEvent, unknown>
): InsereEffect<TState, TEvent, TValue> {
  return function* (context) {
    const resource = yield* acquire(context);
    return yield* ensuring(use(resource), release(resource))(context);
  };
}

export function when<TState, TEvent>(
  condition: boolean | (() => boolean),
  source: InsereEffect<TState, TEvent, unknown>
): InsereEffect<TState, TEvent, void> {
  return function* (context) {
    const enabled = typeof condition === "function" ? condition() : condition;

    if (enabled) {
      yield* source(context);
    }
  };
}

export function unless<TState, TEvent>(
  condition: boolean | (() => boolean),
  source: InsereEffect<TState, TEvent, unknown>
): InsereEffect<TState, TEvent, void> {
  return when(
    () => !(typeof condition === "function" ? condition() : condition),
    source
  );
}

export function repeat<TState, TEvent>(
  count: number,
  source: InsereEffect<TState, TEvent, unknown>
): InsereEffect<TState, TEvent, void> {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`Invalid repeat count: ${count}`);
  }

  return function* (context) {
    for (let index = 0; index < count; index += 1) {
      yield* source(context);
    }
  };
}

export function forEach<TState, TEvent, TItem>(
  items: Iterable<TItem>,
  each: (item: TItem, index: number) => InsereEffect<TState, TEvent, unknown>
): InsereEffect<TState, TEvent, void> {
  return function* (context) {
    let index = 0;

    for (const item of items) {
      yield* each(item, index)(context);
      index += 1;
    }
  };
}

export function whileEffect<TState, TEvent>(
  condition: () => boolean,
  source: InsereEffect<TState, TEvent, unknown>
): InsereEffect<TState, TEvent, void> {
  return function* (context) {
    while (condition()) {
      yield* source(context);
    }
  };
}

export function sequence<TState, TEvent>(
  effects: readonly InsereEffect<TState, TEvent, unknown>[]
): InsereEffect<TState, TEvent, void> {
  return function* (context) {
    for (const item of effects) {
      yield* item(context);
    }
  };
}

export function toRoutine<TState, TEvent, TValue>(
  source: InsereEffect<TState, TEvent, TValue>
): InsereRoutineFactory<TState, TEvent> {
  return function* (context) {
    yield* source(context);
  };
}
