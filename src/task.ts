import {
  err,
  ok,
  toAppError,
  toRoutine,
  type InsereEffect,
  type InsereResult
} from "./effect.js";
import type {
  DirectInsereSnapshot,
  DirectInsereFrameLoopStep,
  DirectInsereStep,
  DirectInsereTask as DirectInsereTaskRuntime
} from "./core.js";
import { frameLoopStep } from "./core.js";
import type { Insere, InsereSnapshot } from "./runtime.js";

export type InsereTaskPolicy = "spawn" | "restart" | "skip";
export type DirectInsereTaskStart = "run" | "frame";
export type InsereTaskApplyStatus = "started" | "restarted" | "skipped";

export interface InsereTaskApplyReport {
  readonly key: string;
  readonly policy: InsereTaskPolicy;
  readonly applied: boolean;
  readonly status: InsereTaskApplyStatus;
}

export type InsereTaskApplyResult = InsereResult<InsereTaskApplyReport>;


export interface InsereTask<TState = unknown, TEvent = unknown, TValue = unknown> {
  readonly key: string;
  readonly effect: InsereEffect<TState, TEvent, TValue>;
  readonly policy?: InsereTaskPolicy;
}

export interface DirectInsereTaskSpec<TState = unknown, TEvent = unknown> {
  readonly key: string;
  readonly step: DirectInsereStep<TState, TEvent>;
  readonly policy?: InsereTaskPolicy;
  readonly start?: DirectInsereTaskStart;
}

export function taskKey(...parts: readonly string[]): string {
  if (parts.length === 0) {
    throw new Error("Insere task key must have at least one part.");
  }

  for (const part of parts) {
    if (part.length === 0) {
      throw new Error("Insere task key parts must not be empty.");
    }
  }

  return parts.join(":");
}

export function taskGroup(...parts: readonly string[]): string {
  return `${taskKey(...parts)}:`;
}

function taskApplyReport(
  key: string,
  policy: InsereTaskPolicy,
  applied: boolean,
  status: InsereTaskApplyStatus
): InsereTaskApplyReport {
  return {
    key,
    policy,
    applied,
    status
  };
}

function taskApplyError(
  error: unknown,
  key: string,
  policy: InsereTaskPolicy
): InsereTaskApplyResult {
  const code =
    error instanceof Error && error.message.includes("already exists")
      ? "TASK_ALREADY_EXISTS"
      : "RUNTIME_ERROR";

  return err(toAppError(error, "ApplyTask", code, {
    key,
    policy
  }));
}

type EffectTaskPolicyHandler = <TState, TEvent, TValue>(
  runtime: Insere<TState, TEvent>,
  item: InsereTask<TState, TEvent, TValue>,
  policy: InsereTaskPolicy
) => InsereTaskApplyResult;

const EFFECT_TASK_POLICIES: Record<InsereTaskPolicy, EffectTaskPolicyHandler> = {
  spawn(runtime, item, policy) {
    spawnTask(runtime, item);
    return ok(taskApplyReport(item.key, policy, true, "started"));
  },
  restart(runtime, item, policy) {
    const taskExisted = runtime.has(item.key);
    restartTask(runtime, item);
    return ok(taskApplyReport(
      item.key,
      policy,
      true,
      taskExisted ? "restarted" : "started"
    ));
  },
  skip(runtime, item, policy) {
    if (runtime.has(item.key)) {
      return ok(taskApplyReport(item.key, policy, false, "skipped"));
    }

    spawnTask(runtime, item);
    return ok(taskApplyReport(item.key, policy, true, "started"));
  }
};

type DirectTaskPolicyHandler = <TState, TEvent>(
  runtime: DirectInsereTaskRuntime<TState, TEvent>,
  item: DirectInsereTaskSpec<TState, TEvent>,
  policy: InsereTaskPolicy
) => InsereTaskApplyResult;

const DIRECT_TASK_POLICIES: Record<InsereTaskPolicy, DirectTaskPolicyHandler> = {
  spawn(runtime, item, policy) {
    spawnDirectTask(runtime, item);
    return ok(taskApplyReport(item.key, policy, true, "started"));
  },
  restart(runtime, item, policy) {
    const taskExisted = runtime.has(item.key);
    restartDirectTask(runtime, item);
    return ok(taskApplyReport(
      item.key,
      policy,
      true,
      taskExisted ? "restarted" : "started"
    ));
  },
  skip(runtime, item, policy) {
    if (runtime.has(item.key)) {
      return ok(taskApplyReport(item.key, policy, false, "skipped"));
    }

    spawnDirectTask(runtime, item);
    return ok(taskApplyReport(item.key, policy, true, "started"));
  }
};

export function task<TState, TEvent, TValue>(
  key: string,
  source: InsereEffect<TState, TEvent, TValue>,
  policy: InsereTaskPolicy = "restart"
): InsereTask<TState, TEvent, TValue> {
  if (key.length === 0) {
    throw new Error("Insere task key must not be empty.");
  }

  return { key, effect: source, policy };
}

export function directTask<TState, TEvent>(
  key: string,
  step: DirectInsereStep<TState, TEvent>,
  policy: InsereTaskPolicy = "restart",
  start: DirectInsereTaskStart = "run"
): DirectInsereTaskSpec<TState, TEvent> {
  if (key.length === 0) {
    throw new Error("DirectInsereTask key must not be empty.");
  }

  return { key, step, policy, start };
}

export function directFrameTask<TState, TEvent>(
  key: string,
  step: DirectInsereStep<TState, TEvent>,
  policy: InsereTaskPolicy = "restart"
): DirectInsereTaskSpec<TState, TEvent> {
  return directTask(key, step, policy, "frame");
}

export function directFrameLoopTask<TState, TEvent>(
  key: string,
  step: DirectInsereFrameLoopStep<TState, TEvent>,
  policy: InsereTaskPolicy = "restart"
): DirectInsereTaskSpec<TState, TEvent> {
  return directFrameTask(key, frameLoopStep(step), policy);
}

export function spawnTask<TState, TEvent, TValue>(
  runtime: Insere<TState, TEvent>,
  item: InsereTask<TState, TEvent, TValue>
): void {
  runtime.spawn(item.key, toRoutine(item.effect));
}

export function restartTask<TState, TEvent, TValue>(
  runtime: Insere<TState, TEvent>,
  item: InsereTask<TState, TEvent, TValue>
): void {
  runtime.restart(item.key, toRoutine(item.effect));
}

/**
 * @deprecated Use applyTaskResult for Result-first code or applyTaskUnsafe when
 * exceptions are intentional.
 */
export function applyTask<TState, TEvent, TValue>(
  runtime: Insere<TState, TEvent>,
  item: InsereTask<TState, TEvent, TValue>,
  policy: InsereTaskPolicy = item.policy ?? "restart"
): boolean {
  return applyTaskUnsafe(runtime, item, policy);
}

export function applyTaskUnsafe<TState, TEvent, TValue>(
  runtime: Insere<TState, TEvent>,
  item: InsereTask<TState, TEvent, TValue>,
  policy: InsereTaskPolicy = item.policy ?? "restart"
): boolean {
  const result = applyTaskResult(runtime, item, policy);

  if (!result.ok) {
    throw result.error;
  }

  return result.value.applied;
}

export function applyTaskResult<TState, TEvent, TValue>(
  runtime: Insere<TState, TEvent>,
  item: InsereTask<TState, TEvent, TValue>,
  policy: InsereTaskPolicy = item.policy ?? "restart"
): InsereTaskApplyResult {
  try {
    return EFFECT_TASK_POLICIES[policy](runtime, item, policy);
  } catch (error) {
    return taskApplyError(error, item.key, policy);
  }
}

export function cancelTask<TState, TEvent>(
  runtime: Insere<TState, TEvent>,
  item: InsereTask<TState, TEvent, unknown> | string
): boolean {
  return runtime.cancel(typeof item === "string" ? item : item.key);
}

export function spawnDirectTask<TState, TEvent>(
  runtime: DirectInsereTaskRuntime<TState, TEvent>,
  item: DirectInsereTaskSpec<TState, TEvent>
): void {
  if (item.start === "frame") {
    runtime.waitFrame(item.key, item.step);
    return;
  }

  runtime.spawn(item.key, item.step);
}

export function restartDirectTask<TState, TEvent>(
  runtime: DirectInsereTaskRuntime<TState, TEvent>,
  item: DirectInsereTaskSpec<TState, TEvent>
): void {
  if (item.start === "frame") {
    runtime.cancel(item.key);
    runtime.waitFrame(item.key, item.step);
    return;
  }

  runtime.restart(item.key, item.step);
}

/**
 * @deprecated Use applyDirectTaskResult for Result-first code or
 * applyDirectTaskUnsafe when exceptions are intentional.
 */
export function applyDirectTask<TState, TEvent>(
  runtime: DirectInsereTaskRuntime<TState, TEvent>,
  item: DirectInsereTaskSpec<TState, TEvent>,
  policy: InsereTaskPolicy = item.policy ?? "restart"
): boolean {
  return applyDirectTaskUnsafe(runtime, item, policy);
}

export function applyDirectTaskUnsafe<TState, TEvent>(
  runtime: DirectInsereTaskRuntime<TState, TEvent>,
  item: DirectInsereTaskSpec<TState, TEvent>,
  policy: InsereTaskPolicy = item.policy ?? "restart"
): boolean {
  const result = applyDirectTaskResult(runtime, item, policy);

  if (!result.ok) {
    throw result.error;
  }

  return result.value.applied;
}

export function applyDirectTaskResult<TState, TEvent>(
  runtime: DirectInsereTaskRuntime<TState, TEvent>,
  item: DirectInsereTaskSpec<TState, TEvent>,
  policy: InsereTaskPolicy = item.policy ?? "restart"
): InsereTaskApplyResult {
  try {
    return DIRECT_TASK_POLICIES[policy](runtime, item, policy);
  } catch (error) {
    return taskApplyError(error, item.key, policy);
  }
}

export function cancelDirectTask<TState, TEvent>(
  runtime: DirectInsereTaskRuntime<TState, TEvent>,
  item: DirectInsereTaskSpec<TState, TEvent> | string
): boolean {
  return runtime.cancel(typeof item === "string" ? item : item.key);
}

export class InsereTaskScope<TState = unknown, TEvent = unknown> {
  readonly #runtime: Insere<TState, TEvent>;
  readonly #prefix: readonly string[];

  constructor(runtime: Insere<TState, TEvent>, prefix: readonly string[] = []) {
    this.#runtime = runtime;
    this.#prefix = [...prefix];
    if (this.#prefix.length > 0) {
      taskKey(...this.#prefix);
    }
  }

  key(...parts: readonly string[]): string {
    return taskKey(...this.#prefix, ...parts);
  }

  group(...parts: readonly string[]): string {
    return taskGroup(...this.#prefix, ...parts);
  }

  child(...parts: readonly string[]): InsereTaskScope<TState, TEvent> {
    return new InsereTaskScope(this.#runtime, [...this.#prefix, ...parts]);
  }

  task<TValue>(
    parts: string | readonly string[],
    source: InsereEffect<TState, TEvent, TValue>,
    policy?: InsereTaskPolicy
  ): InsereTask<TState, TEvent, TValue> {
    return task(
      typeof parts === "string" ? this.key(parts) : this.key(...parts),
      source,
      policy
    );
  }

  has(...parts: readonly string[]): boolean {
    return this.#runtime.has(this.key(...parts));
  }

  keys(...parts: readonly string[]): string[] {
    const prefix = this.#scopePrefix(parts);
    return this.#runtime.keys().filter((key) => key.startsWith(prefix));
  }

  snapshot(...parts: readonly string[]): InsereSnapshot {
    const prefix = this.#scopePrefix(parts);
    const snapshot = this.#runtime.snapshot();
    const entries = snapshot.entries.filter((entry) =>
      entry.key.startsWith(prefix)
    );

    return {
      frame: snapshot.frame,
      now: snapshot.now,
      delta: snapshot.delta,
      size: entries.length,
      entries
    };
  }

  spawn<TValue>(item: InsereTask<TState, TEvent, TValue>): void {
    spawnTask(this.#runtime, item);
  }

  spawnEffect<TValue>(
    parts: string | readonly string[],
    source: InsereEffect<TState, TEvent, TValue>
  ): void {
    this.spawn(this.task(parts, source));
  }

  restart<TValue>(item: InsereTask<TState, TEvent, TValue>): void {
    restartTask(this.#runtime, item);
  }

  restartEffect<TValue>(
    parts: string | readonly string[],
    source: InsereEffect<TState, TEvent, TValue>
  ): void {
    this.restart(this.task(parts, source));
  }

  /**
   * @deprecated Use applyResult for Result-first code or applyUnsafe when
   * exceptions are intentional.
   */
  apply<TValue>(
    item: InsereTask<TState, TEvent, TValue>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.applyUnsafe(item, policy);
  }

  applyUnsafe<TValue>(
    item: InsereTask<TState, TEvent, TValue>,
    policy?: InsereTaskPolicy
  ): boolean {
    return applyTaskUnsafe(this.#runtime, item, policy);
  }

  applyResult<TValue>(
    item: InsereTask<TState, TEvent, TValue>,
    policy?: InsereTaskPolicy
  ): InsereTaskApplyResult {
    return applyTaskResult(this.#runtime, item, policy);
  }

  /**
   * @deprecated Use applyEffectResult for Result-first code or
   * applyEffectUnsafe when exceptions are intentional.
   */
  applyEffect<TValue>(
    parts: string | readonly string[],
    source: InsereEffect<TState, TEvent, TValue>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.applyEffectUnsafe(parts, source, policy);
  }

  applyEffectUnsafe<TValue>(
    parts: string | readonly string[],
    source: InsereEffect<TState, TEvent, TValue>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.applyUnsafe(this.task(parts, source, policy));
  }

  applyEffectResult<TValue>(
    parts: string | readonly string[],
    source: InsereEffect<TState, TEvent, TValue>,
    policy?: InsereTaskPolicy
  ): InsereTaskApplyResult {
    return this.applyResult(this.task(parts, source, policy));
  }

  cancel(item: InsereTask<TState, TEvent, unknown> | string): boolean {
    return cancelTask(this.#runtime, item);
  }

  cancelKey(...parts: readonly string[]): boolean {
    return this.#runtime.cancel(this.key(...parts));
  }

  cancelGroup(prefix: string): number {
    return this.#runtime.cancelGroup(prefix);
  }

  cancelScope(...parts: readonly string[]): number {
    return this.#runtime.cancelGroup(this.group(...parts));
  }

  cancelAll(): void {
    this.#runtime.cancelAll();
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

export class DirectInsereTaskScope<TState = unknown, TEvent = unknown> {
  readonly #runtime: DirectInsereTaskRuntime<TState, TEvent>;
  readonly #prefix: readonly string[];

  constructor(
    runtime: DirectInsereTaskRuntime<TState, TEvent>,
    prefix: readonly string[] = []
  ) {
    this.#runtime = runtime;
    this.#prefix = [...prefix];
    if (this.#prefix.length > 0) {
      taskKey(...this.#prefix);
    }
  }

  key(...parts: readonly string[]): string {
    return taskKey(...this.#prefix, ...parts);
  }

  group(...parts: readonly string[]): string {
    return taskGroup(...this.#prefix, ...parts);
  }

  child(...parts: readonly string[]): DirectInsereTaskScope<TState, TEvent> {
    return new DirectInsereTaskScope(this.#runtime, [...this.#prefix, ...parts]);
  }

  task(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy,
    start?: DirectInsereTaskStart
  ): DirectInsereTaskSpec<TState, TEvent> {
    return directTask(
      typeof parts === "string" ? this.key(parts) : this.key(...parts),
      step,
      policy,
      start
    );
  }

  frameTask(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): DirectInsereTaskSpec<TState, TEvent> {
    return directFrameTask(
      typeof parts === "string" ? this.key(parts) : this.key(...parts),
      step,
      policy
    );
  }

  has(...parts: readonly string[]): boolean {
    return this.#runtime.has(this.key(...parts));
  }

  keys(...parts: readonly string[]): string[] {
    const prefix = this.#scopePrefix(parts);
    return this.#runtime.keys().filter((key) => key.startsWith(prefix));
  }

  snapshot(...parts: readonly string[]): DirectInsereSnapshot {
    const prefix = this.#scopePrefix(parts);
    const snapshot = this.#runtime.snapshot();
    const entries = snapshot.entries.filter((entry) =>
      entry.key.startsWith(prefix)
    );

    return {
      frame: snapshot.frame,
      now: snapshot.now,
      delta: snapshot.delta,
      size: entries.length,
      entries
    };
  }

  spawn(item: DirectInsereTaskSpec<TState, TEvent>): void {
    spawnDirectTask(this.#runtime, item);
  }

  spawnTask(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    start?: DirectInsereTaskStart
  ): void {
    this.spawn(this.task(parts, step, "restart", start));
  }

  restart(item: DirectInsereTaskSpec<TState, TEvent>): void {
    restartDirectTask(this.#runtime, item);
  }

  restartTask(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    start?: DirectInsereTaskStart
  ): void {
    this.restart(this.task(parts, step, "restart", start));
  }

  waitFrame(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>
  ): void {
    this.spawn(this.frameTask(parts, step));
  }

  /**
   * @deprecated Use frameLoopResult or frameLoopUnsafe when exceptions are
   * intentional.
   */
  frameLoop(
    parts: string | readonly string[],
    step: DirectInsereFrameLoopStep<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.frameLoopUnsafe(parts, step, policy);
  }

  frameLoopUnsafe(
    parts: string | readonly string[],
    step: DirectInsereFrameLoopStep<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.applyTaskUnsafe(parts, frameLoopStep(step), policy, "frame");
  }

  frameLoopResult(
    parts: string | readonly string[],
    step: DirectInsereFrameLoopStep<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): InsereTaskApplyResult {
    return this.applyTaskResult(parts, frameLoopStep(step), policy, "frame");
  }

  /**
   * @deprecated Use applyResult for Result-first code or applyUnsafe when
   * exceptions are intentional.
   */
  apply(
    item: DirectInsereTaskSpec<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.applyUnsafe(item, policy);
  }

  applyUnsafe(
    item: DirectInsereTaskSpec<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): boolean {
    return applyDirectTaskUnsafe(this.#runtime, item, policy);
  }

  applyResult(
    item: DirectInsereTaskSpec<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): InsereTaskApplyResult {
    return applyDirectTaskResult(this.#runtime, item, policy);
  }

  /**
   * @deprecated Use applyTaskResult for Result-first code or applyTaskUnsafe
   * when exceptions are intentional.
   */
  applyTask(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy,
    start?: DirectInsereTaskStart
  ): boolean {
    return this.applyTaskUnsafe(parts, step, policy, start);
  }

  applyTaskUnsafe(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy,
    start?: DirectInsereTaskStart
  ): boolean {
    return this.applyUnsafe(this.task(parts, step, policy, start));
  }

  applyTaskResult(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy,
    start?: DirectInsereTaskStart
  ): InsereTaskApplyResult {
    return this.applyResult(this.task(parts, step, policy, start));
  }

  cancel(item: DirectInsereTaskSpec<TState, TEvent> | string): boolean {
    return cancelDirectTask(this.#runtime, item);
  }

  cancelKey(...parts: readonly string[]): boolean {
    return this.#runtime.cancel(this.key(...parts));
  }

  cancelGroup(prefix: string): number {
    return this.#runtime.cancelGroup(prefix);
  }

  cancelScope(...parts: readonly string[]): number {
    return this.#runtime.cancelGroup(this.group(...parts));
  }

  cancelAll(): void {
    this.#runtime.cancelAll();
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
