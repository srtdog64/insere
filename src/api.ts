import {
  DirectInsereTask,
  type DirectInsereOptions,
  type DirectInsereSnapshot,
  type DirectInsereStep
} from "./core.js";
import { err, ok, toRoutine, type InsereEffect } from "./effect.js";
import { Insere, type InsereOptions, type InsereSnapshot } from "./runtime.js";
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
    InsereOptions<TState, TEvent> {}

export interface InsereApiSnapshot {
  readonly frame: number;
  readonly now: number;
  readonly delta: number;
  readonly size: number;
  readonly direct: DirectInsereSnapshot;
  readonly effect: InsereSnapshot;
}

export class InsereApi<TState = unknown, TEvent = unknown> {
  readonly direct: DirectInsereTask<TState, TEvent>;
  readonly effect: Insere<TState, TEvent>;

  constructor(options: InsereApiOptions<TState, TEvent> = {}) {
    this.direct = new DirectInsereTask(options);
    this.effect = new Insere(options);
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
    this.direct.tick(now);
    this.effect.tick(now);
  }

  runIdle(): void {
    this.direct.runIdle();
    this.effect.runIdle();
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
        return err(new Error(`InsereApi task already exists: ${key}`));
      }

      if (resolvedPolicy === "restart") {
        this.cancel(key);
      }

      const result = applyDirectTaskResult(
        this.direct,
        directTask(key, step, resolvedPolicy, start),
        resolvedPolicy
      );

      if (result.ok && resolvedPolicy === "restart" && keyExisted) {
        return ok({
          ...result.value,
          status: "restarted"
        });
      }

      return result;
    } catch (error) {
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
    this.cancel(key);
    this.direct.restart(key, step);
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
        return err(new Error(`InsereApi task already exists: ${key}`));
      }

      if (resolvedPolicy === "restart") {
        this.cancel(key);
      }

      const result = applyTaskResult(
        this.effect,
        task(key, source, resolvedPolicy),
        resolvedPolicy
      );

      if (result.ok && resolvedPolicy === "restart" && keyExisted) {
        return ok({
          ...result.value,
          status: "restarted"
        });
      }

      return result;
    } catch (error) {
      return err(error);
    }
  }

  restartEffect<TValue>(
    key: string,
    source: InsereEffect<TState, TEvent, TValue>
  ): void {
    this.cancel(key);
    this.effect.restart(key, toRoutine(source));
  }

  cancel(key: string): boolean {
    const directCancelled = this.direct.cancel(key);
    const effectCancelled = this.effect.cancel(key);

    return directCancelled || effectCancelled;
  }

  cancelGroup(prefix: string): number {
    return this.direct.cancelGroup(prefix) + this.effect.cancelGroup(prefix);
  }

  cancelAll(): void {
    this.direct.cancelAll();
    this.effect.cancelAll();
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
