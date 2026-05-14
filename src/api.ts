import {
  DirectInsereTask,
  type DirectInsereOptions,
  type DirectInsereSnapshot,
  type DirectInsereStep
} from "./core.js";
import { err, ok, toRoutine, type InsereEffect } from "./effect.js";
import { logInsereBug, type InsereLogger } from "./logging.js";
import { Insere, type InsereOptions, type InsereSnapshot } from "./runtime.js";
import {
  failureResult,
  normalizeInsereSupervision,
  type InsereFailure,
  type InsereFailureOperation,
  type InsereSupervisionOptions,
  type NormalizedInsereSupervision
} from "./supervision.js";
import {
  DirectInsereTaskScope,
  InsereTaskScope,
  applyDirectTaskResult,
  applyTaskResult,
  directTask,
  task,
  taskGroup,
  taskKey,
  type DirectInsereTaskStart,
  type InsereTaskApplyResult,
  type InsereTaskPolicy
} from "./task.js";

export interface InsereApiOptions<TState = unknown, TEvent = unknown>
  extends DirectInsereOptions<TState, TEvent>,
    InsereOptions<TState, TEvent> {
  readonly logger?: InsereLogger;
  readonly supervision?: InsereSupervisionOptions<TEvent>;
}

export interface InsereApiSnapshot {
  readonly frame: number;
  readonly now: number;
  readonly delta: number;
  readonly size: number;
  readonly direct: DirectInsereSnapshot;
  readonly effect: InsereSnapshot;
}

type SupervisedTask<TState, TEvent> =
  | {
      readonly runtime: "direct";
      readonly key: string;
      readonly step: DirectInsereStep<TState, TEvent>;
      readonly start: DirectInsereTaskStart | undefined;
      attempts: number;
    }
  | {
      readonly runtime: "effect";
      readonly key: string;
      readonly source: InsereEffect<TState, TEvent, unknown>;
      attempts: number;
    };

export class InsereApi<TState = unknown, TEvent = unknown> {
  readonly direct: DirectInsereTask<TState, TEvent>;
  readonly effect: Insere<TState, TEvent>;
  readonly #logger: InsereLogger | undefined;
  readonly #dispatch: (event: TEvent) => void;
  readonly #supervision: NormalizedInsereSupervision<TEvent>;
  readonly #supervisedTasks = new Map<string, SupervisedTask<TState, TEvent>>();
  #lastFailure: InsereFailure | undefined;

  constructor(options: InsereApiOptions<TState, TEvent> = {}) {
    this.#logger = options.logger;
    this.#dispatch = options.dispatch ?? (() => undefined);
    this.#supervision = normalizeInsereSupervision(options.supervision);

    const reportFailure = (failure: InsereFailure) => {
      this.#lastFailure = failure;
      this.#callFailureReporter("options.onFailure", failure, options.onFailure);
      this.#callFailureReporter(
        "supervision.onFailure",
        failure,
        this.#supervision.onFailure
      );
    };

    this.direct = new DirectInsereTask({
      ...options,
      dispatch: this.#dispatch,
      onFailure: reportFailure
    });
    this.effect = new Insere({
      ...options,
      dispatch: this.#dispatch,
      onFailure: reportFailure
    });
  }

  get frame(): number {
    return this.direct.frame;
  }

  get now(): number {
    return this.direct.now;
  }

  get delta(): number {
    return this.direct.delta;
  }

  get size(): number {
    return this.direct.size + this.effect.size;
  }

  scope(...parts: readonly string[]): InsereApiScope<TState, TEvent> {
    return new InsereApiScope(this, parts);
  }

  key(...parts: readonly string[]): string {
    return taskKey(...parts);
  }

  group(...parts: readonly string[]): string {
    return taskGroup(...parts);
  }

  tick(now: number): void {
    try {
      this.direct.tick(now);
    } catch (error) {
      const failure = this.#failure("tick", error, undefined, undefined, {
        tickNow: now
      });
      this.#logFailure(failure);
      this.#supervise(failure);
    }

    try {
      this.effect.tick(now);
    } catch (error) {
      const failure = this.#failure("tick", error, undefined, undefined, {
        tickNow: now
      });
      this.#logFailure(failure);
      this.#supervise(failure);
    }

    this.#pruneCompletedTasks();
  }

  runIdle(): void {
    try {
      this.direct.runIdle();
    } catch (error) {
      const failure = this.#failure("runIdle", error);
      this.#logFailure(failure);
      this.#supervise(failure);
    }

    try {
      this.effect.runIdle();
    } catch (error) {
      const failure = this.#failure("runIdle", error);
      this.#logFailure(failure);
      this.#supervise(failure);
    }

    this.#pruneCompletedTasks();
  }

  has(key: string): boolean {
    return this.direct.has(key) || this.effect.has(key);
  }

  keys(): string[] {
    const keys = new Set(this.direct.keys());

    for (const key of this.effect.keys()) {
      keys.add(key);
    }

    return [...keys];
  }

  snapshot(): InsereApiSnapshot {
    const direct = this.direct.snapshot();
    const effect = this.effect.snapshot();

    return {
      frame: direct.frame,
      now: direct.now,
      delta: direct.delta,
      size: direct.size + effect.size,
      direct,
      effect
    };
  }

  applyDirect(
    key: string,
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy,
    start?: DirectInsereTaskStart
  ): boolean {
    const result = this.applyDirectResult(key, step, policy, start);

    if (!result.ok) {
      throw result.error;
    }

    return result.value.applied;
  }

  applyDirectResult(
    key: string,
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy,
    start?: DirectInsereTaskStart
  ): InsereTaskApplyResult {
    try {
      const resolvedPolicy = policy ?? "restart";
      const keyExisted = this.has(key);

      if (resolvedPolicy === "skip" && keyExisted) {
        return ok({
          key,
          policy: resolvedPolicy,
          applied: false,
          status: "skipped"
        });
      }

      if (resolvedPolicy === "spawn" && keyExisted) {
        const error = new Error(`InsereApi task already exists: ${key}`);
        this.#logBug("applyDirectResult", error, key, resolvedPolicy, {
          start: start ?? "run"
        });
        return err(error);
      }

      if (resolvedPolicy === "restart") {
        this.cancel(key);
      }

      const result = applyDirectTaskResult(
        this.direct,
        directTask(key, step, resolvedPolicy, start),
        resolvedPolicy
      );

      if (!result.ok) {
        const failure = this.#failure(
          "applyDirectResult",
          result.error,
          key,
          resolvedPolicy,
          { start: start ?? "run" }
        );
        this.#logFailure(failure);
        return result;
      }

      if (result.ok && resolvedPolicy === "restart" && keyExisted) {
        this.#rememberDirect(key, step, start);
        return ok({
          ...result.value,
          status: "restarted"
        });
      }

      if (result.ok && result.value.applied) {
        this.#rememberDirect(key, step, start);
      }

      return result;
    } catch (error) {
      const failure = this.#failure("applyDirectResult", error, key, policy, {
        start: start ?? "run"
      });
      this.#logFailure(failure);
      return err(error);
    }
  }

  waitFrame(
    key: string,
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.applyDirect(key, step, policy, "frame");
  }

  restartDirect(key: string, step: DirectInsereStep<TState, TEvent>): void {
    try {
      this.cancel(key);
      this.direct.restart(key, step);
      this.#rememberDirect(key, step);
    } catch (error) {
      const failure = this.#failure("restartDirect", error, key, "restart");
      this.#logFailure(failure);
      throw error;
    }
  }

  applyEffect<TValue>(
    key: string,
    source: InsereEffect<TState, TEvent, TValue>,
    policy?: InsereTaskPolicy
  ): boolean {
    const result = this.applyEffectResult(key, source, policy);

    if (!result.ok) {
      throw result.error;
    }

    return result.value.applied;
  }

  applyEffectResult<TValue>(
    key: string,
    source: InsereEffect<TState, TEvent, TValue>,
    policy?: InsereTaskPolicy
  ): InsereTaskApplyResult {
    try {
      const resolvedPolicy = policy ?? "restart";
      const keyExisted = this.has(key);

      if (resolvedPolicy === "skip" && keyExisted) {
        return ok({
          key,
          policy: resolvedPolicy,
          applied: false,
          status: "skipped"
        });
      }

      if (resolvedPolicy === "spawn" && keyExisted) {
        const error = new Error(`InsereApi task already exists: ${key}`);
        this.#logBug("applyEffectResult", error, key, resolvedPolicy);
        return err(error);
      }

      if (resolvedPolicy === "restart") {
        this.cancel(key);
      }

      const result = applyTaskResult(
        this.effect,
        task(key, source, resolvedPolicy),
        resolvedPolicy
      );

      if (!result.ok) {
        const failure = this.#failure(
          "applyEffectResult",
          result.error,
          key,
          resolvedPolicy
        );
        this.#logFailure(failure);
        return result;
      }

      if (result.ok && resolvedPolicy === "restart" && keyExisted) {
        this.#rememberEffect(key, source);
        return ok({
          ...result.value,
          status: "restarted"
        });
      }

      if (result.ok && result.value.applied) {
        this.#rememberEffect(key, source);
      }

      return result;
    } catch (error) {
      const failure = this.#failure("applyEffectResult", error, key, policy);
      this.#logFailure(failure);
      return err(error);
    }
  }

  restartEffect<TValue>(
    key: string,
    source: InsereEffect<TState, TEvent, TValue>
  ): void {
    try {
      this.cancel(key);
      this.effect.restart(key, toRoutine(source));
      this.#rememberEffect(key, source);
    } catch (error) {
      const failure = this.#failure("restartEffect", error, key, "restart");
      this.#logFailure(failure);
      throw error;
    }
  }

  cancel(key: string): boolean {
    try {
      const directCancelled = this.direct.cancel(key);
      const effectCancelled = this.effect.cancel(key);

      if (directCancelled || effectCancelled) {
        this.#supervisedTasks.delete(key);
      }

      return directCancelled || effectCancelled;
    } catch (error) {
      const failure = this.#failure("cancel", error, key);
      this.#logFailure(failure);
      throw error;
    }
  }

  cancelGroup(prefix: string): number {
    try {
      const count = this.direct.cancelGroup(prefix) + this.effect.cancelGroup(prefix);

      for (const key of [...this.#supervisedTasks.keys()]) {
        if (key.startsWith(prefix)) {
          this.#supervisedTasks.delete(key);
        }
      }

      return count;
    } catch (error) {
      const failure = this.#failure("cancelGroup", error, prefix);
      this.#logFailure(failure);
      throw error;
    }
  }

  cancelAll(): void {
    try {
      this.direct.cancelAll();
      this.effect.cancelAll();
      this.#supervisedTasks.clear();
    } catch (error) {
      const failure = this.#failure("cancelAll", error);
      this.#logFailure(failure);
      throw error;
    }
  }

  #failure(
    operation: InsereFailureOperation,
    cause: unknown,
    key?: string,
    policy?: InsereTaskPolicy,
    data?: Readonly<Record<string, unknown>>
  ): InsereFailure {
    const reported = this.#lastFailure;
    this.#lastFailure = undefined;

    if (reported && reported.cause === cause) {
      return {
        ...reported,
        operation,
        ...(policy !== undefined ? { policy } : {}),
        ...(data !== undefined ? { data: { ...reported.data, ...data } } : {})
      };
    }

    return {
      runtime: "api",
      operation,
      cause,
      ...(key !== undefined ? { key } : {}),
      ...(policy !== undefined ? { policy } : {}),
      frame: this.frame,
      now: this.now,
      delta: this.delta,
      ...(data !== undefined ? { data } : {})
    };
  }

  #logFailure(failure: InsereFailure): void {
    const data: Record<string, unknown> = {};

    if (failure.data !== undefined) {
      Object.assign(data, failure.data);
    }

    if (failure.wait !== undefined) {
      data.wait = failure.wait;
    }

    if (failure.attempts !== undefined) {
      data.attempts = failure.attempts;
    }

    logInsereBug({
      operation: failure.operation,
      cause: failure.cause,
      runtime: failure.runtime,
      ...(this.#logger !== undefined ? { logger: this.#logger } : {}),
      ...(failure.key !== undefined ? { key: failure.key } : {}),
      ...(failure.policy !== undefined ? { policy: failure.policy } : {}),
      frame: failure.frame,
      now: failure.now,
      ...(failure.delta !== undefined ? { delta: failure.delta } : {}),
      ...(Object.keys(data).length > 0 ? { data } : {})
    });
  }

  #logBug(
    operation: InsereFailureOperation,
    cause: unknown,
    key?: string,
    policy?: InsereTaskPolicy,
    data?: Readonly<Record<string, unknown>>
  ): void {
    this.#logFailure(this.#failure(operation, cause, key, policy, data));
  }

  #callFailureReporter(
    reporter: string,
    failure: InsereFailure,
    callback: ((failure: InsereFailure) => void) | undefined
  ): void {
    if (!callback) {
      return;
    }

    try {
      callback(failure);
    } catch (error) {
      logInsereBug({
        operation: failure.operation,
        cause: error,
        runtime: "api",
        ...(this.#logger !== undefined ? { logger: this.#logger } : {}),
        ...(failure.key !== undefined ? { key: failure.key } : {}),
        frame: failure.frame,
        now: failure.now,
        ...(failure.delta !== undefined ? { delta: failure.delta } : {}),
        data: {
          reporter,
          originalCause: failure.cause
        }
      });
    }
  }

  #supervise(failure: InsereFailure): void {
    switch (this.#supervision.policy) {
      case "bubble":
        this.#pruneCompletedTasks();
        throw failure.cause;
      case "logAndStop":
        return;
      case "dispatchAndStop":
        if (!this.#supervision.toEvent) {
          throw failure.cause;
        }

        this.#dispatch(this.#supervision.toEvent(failure));
        return;
      case "convertToResult":
        this.#supervision.onResult?.(failureResult(failure));
        return;
      case "restart":
        if (this.#restartFailedTask(failure)) {
          return;
        }

        this.#pruneCompletedTasks();
        throw failure.cause;
    }
  }

  #restartFailedTask(failure: InsereFailure): boolean {
    if (!failure.key) {
      return false;
    }

    const item = this.#supervisedTasks.get(failure.key);
    if (!item || item.attempts >= this.#supervision.maxRestarts) {
      return false;
    }

    item.attempts += 1;

    try {
      if (item.runtime === "direct") {
        if (item.start === "frame") {
          this.direct.waitFrame(item.key, item.step);
        } else {
          this.direct.restart(item.key, item.step);
        }
      } else {
        this.effect.restart(item.key, toRoutine(item.source));
      }
    } catch (error) {
      const nextFailure: InsereFailure = {
        runtime: item.runtime,
        operation: failure.operation,
        key: item.key,
        frame: this.frame,
        now: this.now,
        delta: this.delta,
        cause: error,
        attempts: item.attempts
      };
      this.#logFailure(nextFailure);
      return false;
    }

    return true;
  }

  #rememberDirect(
    key: string,
    step: DirectInsereStep<TState, TEvent>,
    start?: DirectInsereTaskStart
  ): void {
    if (!this.has(key)) {
      this.#supervisedTasks.delete(key);
      return;
    }

    this.#supervisedTasks.set(key, {
      runtime: "direct",
      key,
      step,
      start,
      attempts: 0
    });
  }

  #rememberEffect<TValue>(
    key: string,
    source: InsereEffect<TState, TEvent, TValue>
  ): void {
    if (!this.has(key)) {
      this.#supervisedTasks.delete(key);
      return;
    }

    this.#supervisedTasks.set(key, {
      runtime: "effect",
      key,
      source,
      attempts: 0
    });
  }

  #pruneCompletedTasks(): void {
    for (const key of this.#supervisedTasks.keys()) {
      if (!this.has(key)) {
        this.#supervisedTasks.delete(key);
      }
    }
  }
}

export class InsereApiScope<TState = unknown, TEvent = unknown> {
  readonly #api: InsereApi<TState, TEvent>;
  readonly #prefix: readonly string[];
  readonly direct: DirectInsereTaskScope<TState, TEvent>;
  readonly effect: InsereTaskScope<TState, TEvent>;

  constructor(
    api: InsereApi<TState, TEvent>,
    prefix: readonly string[] = []
  ) {
    this.#api = api;
    this.#prefix = [...prefix];
    this.direct = new DirectInsereTaskScope(api.direct, this.#prefix);
    this.effect = new InsereTaskScope(api.effect, this.#prefix);
  }

  key(...parts: readonly string[]): string {
    return taskKey(...this.#prefix, ...parts);
  }

  group(...parts: readonly string[]): string {
    return taskGroup(...this.#prefix, ...parts);
  }

  child(...parts: readonly string[]): InsereApiScope<TState, TEvent> {
    return new InsereApiScope(this.#api, [...this.#prefix, ...parts]);
  }

  has(...parts: readonly string[]): boolean {
    return this.#api.has(this.key(...parts));
  }

  keys(...parts: readonly string[]): string[] {
    const prefix = this.#scopePrefix(parts);
    return this.#api.keys().filter((key) => key.startsWith(prefix));
  }

  snapshot(...parts: readonly string[]): InsereApiSnapshot {
    const prefix = this.#scopePrefix(parts);
    const snapshot = this.#api.snapshot();
    const directEntries = snapshot.direct.entries.filter((entry) =>
      entry.key.startsWith(prefix)
    );
    const effectEntries = snapshot.effect.entries.filter((entry) =>
      entry.key.startsWith(prefix)
    );

    return {
      frame: snapshot.frame,
      now: snapshot.now,
      delta: snapshot.delta,
      size: directEntries.length + effectEntries.length,
      direct: {
        frame: snapshot.direct.frame,
        now: snapshot.direct.now,
        delta: snapshot.direct.delta,
        size: directEntries.length,
        entries: directEntries
      },
      effect: {
        frame: snapshot.effect.frame,
        now: snapshot.effect.now,
        delta: snapshot.effect.delta,
        size: effectEntries.length,
        entries: effectEntries
      }
    };
  }

  applyDirect(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy,
    start?: DirectInsereTaskStart
  ): boolean {
    return this.#api.applyDirect(this.#key(parts), step, policy, start);
  }

  applyDirectResult(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy,
    start?: DirectInsereTaskStart
  ): InsereTaskApplyResult {
    return this.#api.applyDirectResult(this.#key(parts), step, policy, start);
  }

  waitFrame(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.#api.waitFrame(this.#key(parts), step, policy);
  }

  applyEffect<TValue>(
    parts: string | readonly string[],
    source: InsereEffect<TState, TEvent, TValue>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.#api.applyEffect(this.#key(parts), source, policy);
  }

  applyEffectResult<TValue>(
    parts: string | readonly string[],
    source: InsereEffect<TState, TEvent, TValue>,
    policy?: InsereTaskPolicy
  ): InsereTaskApplyResult {
    return this.#api.applyEffectResult(this.#key(parts), source, policy);
  }

  cancelKey(...parts: readonly string[]): boolean {
    return this.#api.cancel(this.key(...parts));
  }

  cancelScope(...parts: readonly string[]): number {
    return this.#api.cancelGroup(this.group(...parts));
  }

  #key(parts: string | readonly string[]): string {
    return typeof parts === "string" ? this.key(parts) : this.key(...parts);
  }

  #scopePrefix(parts: readonly string[]): string {
    if (parts.length > 0) {
      return this.group(...parts);
    }

    if (this.#prefix.length === 0) {
      return "";
    }

    return this.group();
  }
}

export function createInsereApi<TState = unknown, TEvent = unknown>(
  options: InsereApiOptions<TState, TEvent> = {}
): InsereApi<TState, TEvent> {
  return new InsereApi(options);
}

export {
  createBufferedInsereLogger,
  createConsoleInsereLogger,
  logInsereBug,
  type BufferedInsereLogger,
  type InsereBugLogOptions,
  type InsereConsoleLike,
  type InsereLogger,
  type InsereLogKind,
  type InsereLogLevel,
  type InsereLogRecord,
  type InsereLogRuntime
} from "./logging.js";
export {
  failureResult,
  normalizeInsereSupervision,
  type InsereFailure,
  type InsereFailureOperation,
  type InsereRuntimeKind,
  type InsereSupervisionOptions,
  type InsereSupervisionPolicy,
  type NormalizedInsereSupervision
} from "./supervision.js";
