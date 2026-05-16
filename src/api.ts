import {
  DirectInsereTask,
  frameLoopStep,
  type DirectInsereOptions,
  type DirectInsereFrameLoopStep,
  type DirectInsereSnapshot,
  type DirectInsereStep
} from "./core.js";
import {
  err,
  ok,
  toRoutine,
  type ErrorCode,
  type InsereEffect,
  type InsereResult,
  type Stage
} from "./effect.js";
import { logInsereBug, type InsereLogger } from "./logging.js";
import { Insere, type InsereOptions, type InsereSnapshot } from "./runtime.js";
import {
  failureResult,
  normalizeInsereSupervision,
  type InsereFailure,
  type InsereFailureResult,
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

export type InsereRequestIdProvider = string | (() => string | undefined);

export interface InsereApiOptions<TState = unknown, TEvent = unknown>
  extends DirectInsereOptions<TState, TEvent>,
    InsereOptions<TState, TEvent> {
  readonly logger?: InsereLogger;
  readonly requestId?: InsereRequestIdProvider;
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
  readonly #requestId: InsereRequestIdProvider | undefined;
  readonly #dispatch: (event: TEvent) => void;
  readonly #supervision: NormalizedInsereSupervision<TEvent>;
  readonly #supervisedTasks = new Map<string, SupervisedTask<TState, TEvent>>();
  readonly #pendingFailures: InsereFailure[] = [];

  constructor(options: InsereApiOptions<TState, TEvent> = {}) {
    this.#logger = options.logger;
    this.#requestId = options.requestId;
    this.#dispatch = options.dispatch ?? (() => undefined);
    this.#supervision = normalizeInsereSupervision(options.supervision);

    const reportFailure = (failure: InsereFailure) => {
      const fullFailure = this.#failure(
        failure.operation,
        failure.cause,
        failure.key,
        failure.policy,
        failure.data
      );

      this.#pendingFailures.push(fullFailure);
      this.#callFailureReporter("options.onFailure", fullFailure, options.onFailure);
      this.#callFailureReporter(
        "supervision.onFailure",
        fullFailure,
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

  tick(now: number): InsereResult<void> {
    let firstFailure: InsereFailure | undefined;

    try {
      this.direct.tick(now);
    } catch (error) {
      const failure = this.#failure("tick", error, undefined, undefined, {
        tickNow: now
      });
      this.#logFailure(failure);
      this.#supervise(failure);
      firstFailure = failure;
    }

    const directFailure = this.#drainReportedFailures();
    if (directFailure) {
      firstFailure ??= directFailure;
    }

    try {
      this.effect.tick(now);
    } catch (error) {
      const failure = this.#failure("tick", error, undefined, undefined, {
        tickNow: now
      });
      this.#logFailure(failure);
      this.#supervise(failure);
      firstFailure ??= failure;
    }

    const effectFailure = this.#drainReportedFailures();
    if (effectFailure) {
      firstFailure ??= effectFailure;
    }

    this.#pruneCompletedTasks();
    if (firstFailure) {
      return err(firstFailure);
    }

    return ok(undefined);
  }

  runIdle(): InsereResult<void> {
    let firstFailure: InsereFailure | undefined;

    try {
      this.direct.runIdle();
    } catch (error) {
      const failure = this.#failure("runIdle", error);
      this.#logFailure(failure);
      this.#supervise(failure);
      firstFailure = failure;
    }

    const directFailure = this.#drainReportedFailures();
    if (directFailure) {
      firstFailure ??= directFailure;
    }

    try {
      this.effect.runIdle();
    } catch (error) {
      const failure = this.#failure("runIdle", error);
      this.#logFailure(failure);
      this.#supervise(failure);
      firstFailure ??= failure;
    }

    const effectFailure = this.#drainReportedFailures();
    if (effectFailure) {
      firstFailure ??= effectFailure;
    }

    this.#pruneCompletedTasks();
    if (firstFailure) {
      return err(firstFailure);
    }

    return ok(undefined);
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

  /**
   * @deprecated Use applyDirectResult for Result-first host code or
   * applyDirectUnsafe when exceptions are intentional.
   */
  applyDirect(
    key: string,
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy,
    start?: DirectInsereTaskStart
  ): boolean {
    return this.applyDirectUnsafe(key, step, policy, start);
  }

  applyDirectUnsafe(
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

      const skip = this.#skipExistingTask(key, resolvedPolicy, keyExisted);
      if (skip) {
        return skip;
      }

      if (resolvedPolicy === "spawn" && keyExisted) {
        return this.#duplicateDirectSpawn(key, resolvedPolicy, start);
      }

      if (resolvedPolicy === "restart") {
        return this.#applyDirectRestart(key, step, start, keyExisted);
      }

      return this.#applyDirectPolicy(key, step, resolvedPolicy, start);
    } catch (error) {
      const failure = this.#failure("applyDirectResult", error, key, policy, {
        start: start ?? "run"
      });
      this.#logFailure(failure);
      return err(failure);
    }
  }

  /**
   * @deprecated Use applyDirectResult(..., "restart", "frame") or
   * waitFrameUnsafe when exceptions are intentional.
   */
  waitFrame(
    key: string,
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.waitFrameUnsafe(key, step, policy);
  }

  waitFrameUnsafe(
    key: string,
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.applyDirectUnsafe(key, step, policy, "frame");
  }

  /**
   * @deprecated Use frameLoopResult or frameLoopUnsafe when exceptions are
   * intentional.
   */
  frameLoop(
    key: string,
    step: DirectInsereFrameLoopStep<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.frameLoopUnsafe(key, step, policy);
  }

  frameLoopUnsafe(
    key: string,
    step: DirectInsereFrameLoopStep<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.applyDirectUnsafe(key, frameLoopStep(step), policy, "frame");
  }

  frameLoopResult(
    key: string,
    step: DirectInsereFrameLoopStep<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): InsereTaskApplyResult {
    return this.applyDirectResult(key, frameLoopStep(step), policy, "frame");
  }

  restartDirect(key: string, step: DirectInsereStep<TState, TEvent>): void {
    try {
      if (this.effect.has(key)) {
        this.effect.cancel(key);
      }
      this.direct.restart(key, step);
      this.#rememberDirect(key, step);
    } catch (error) {
      const failure = this.#failure("restartDirect", error, key, "restart");
      this.#logFailure(failure);
      throw error;
    }
  }

  /**
   * @deprecated Use applyEffectResult for Result-first host code or
   * applyEffectUnsafe when exceptions are intentional.
   */
  applyEffect<TValue>(
    key: string,
    source: InsereEffect<TState, TEvent, TValue>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.applyEffectUnsafe(key, source, policy);
  }

  applyEffectUnsafe<TValue>(
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

      const skip = this.#skipExistingTask(key, resolvedPolicy, keyExisted);
      if (skip) {
        return skip;
      }

      if (resolvedPolicy === "spawn" && keyExisted) {
        return this.#duplicateEffectSpawn(key, resolvedPolicy);
      }

      if (resolvedPolicy === "restart") {
        return this.#applyEffectRestart(key, source, keyExisted);
      }

      return this.#applyEffectPolicy(key, source, resolvedPolicy);
    } catch (error) {
      const failure = this.#failure("applyEffectResult", error, key, policy);
      this.#logFailure(failure);
      return err(failure);
    }
  }

  #skipExistingTask(
    key: string,
    policy: InsereTaskPolicy,
    keyExisted: boolean
  ): InsereTaskApplyResult | undefined {
    if (policy !== "skip" || !keyExisted) {
      return undefined;
    }

    return ok({
      key,
      policy,
      applied: false,
      status: "skipped"
    });
  }

  #duplicateDirectSpawn(
    key: string,
    policy: InsereTaskPolicy,
    start: DirectInsereTaskStart | undefined
  ): InsereTaskApplyResult {
    const error = new Error(`InsereApi task already exists: ${key}`);
    const data = { start: start ?? "run" };
    this.#logBug("applyDirectResult", error, key, policy, data);
    return err(this.#failure("applyDirectResult", error, key, policy, data));
  }

  #duplicateEffectSpawn(
    key: string,
    policy: InsereTaskPolicy
  ): InsereTaskApplyResult {
    const error = new Error(`InsereApi task already exists: ${key}`);
    this.#logBug("applyEffectResult", error, key, policy);
    return err(this.#failure("applyEffectResult", error, key, policy));
  }

  #applyDirectRestart(
    key: string,
    step: DirectInsereStep<TState, TEvent>,
    start: DirectInsereTaskStart | undefined,
    keyExisted: boolean
  ): InsereTaskApplyResult {
    if (this.effect.has(key)) {
      this.effect.cancel(key);
    }

    if (start === "frame") {
      this.direct.cancel(key);
      this.direct.waitFrame(key, step);
    } else {
      this.direct.restart(key, step);
    }

    this.#rememberDirect(key, step, start);
    return ok({
      key,
      policy: "restart",
      applied: true,
      status: keyExisted ? "restarted" : "started"
    });
  }

  #applyEffectRestart<TValue>(
    key: string,
    source: InsereEffect<TState, TEvent, TValue>,
    keyExisted: boolean
  ): InsereTaskApplyResult {
    if (this.direct.has(key)) {
      this.direct.cancel(key);
    }

    this.effect.restart(key, toRoutine(source));
    this.#rememberEffect(key, source);
    return ok({
      key,
      policy: "restart",
      applied: true,
      status: keyExisted ? "restarted" : "started"
    });
  }

  #applyDirectPolicy(
    key: string,
    step: DirectInsereStep<TState, TEvent>,
    policy: InsereTaskPolicy,
    start: DirectInsereTaskStart | undefined
  ): InsereTaskApplyResult {
    const result = applyDirectTaskResult(
      this.direct,
      directTask(key, step, policy, start),
      policy
    );

    if (!result.ok) {
      const failure = this.#failure(
        "applyDirectResult",
        result.error.cause ?? result.error,
        key,
        policy,
        { start: start ?? "run" }
      );
      this.#logFailure(failure);
      return err(failure);
    }

    if (result.value.applied) {
      this.#rememberDirect(key, step, start);
    }

    return result;
  }

  #applyEffectPolicy<TValue>(
    key: string,
    source: InsereEffect<TState, TEvent, TValue>,
    policy: InsereTaskPolicy
  ): InsereTaskApplyResult {
    const result = applyTaskResult(
      this.effect,
      task(key, source, policy),
      policy
    );

    if (!result.ok) {
      const failure = this.#failure(
        "applyEffectResult",
        result.error.cause ?? result.error,
        key,
        policy
      );
      this.#logFailure(failure);
      return err(failure);
    }

    if (result.value.applied) {
      this.#rememberEffect(key, source);
    }

    return result;
  }

  restartEffect<TValue>(
    key: string,
    source: InsereEffect<TState, TEvent, TValue>
  ): void {
    try {
      if (this.direct.has(key)) {
        this.direct.cancel(key);
      }
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
    policy?: string,
    data?: Readonly<Record<string, unknown>>
  ): InsereFailure {
    const baseFailure = {
      runtime: "api" as const,
      operation,
      cause,
      ...(key !== undefined ? { key } : {}),
      ...(policy !== undefined ? { policy } : {}),
      frame: this.frame,
      now: this.now,
      delta: this.delta,
      ...(data !== undefined ? { data } : {})
    };

    return {
      ...baseFailure,
      code: this.#mapErrorCode(cause),
      stage: this.#mapStage(operation),
      message: cause instanceof Error ? cause.message : String(cause)
    };
  }

  #mapStage(operation: InsereFailureOperation): Stage {
    switch (operation) {
      case "tick":
        return "Tick";
      case "runIdle":
        return "Tick";
      case "applyDirectResult":
      case "applyEffectResult":
        return "ApplyTask";
      case "cancel":
      case "cancelAll":
      case "cancelGroup":
        return "Cancel";
      case "restartDirect":
      case "restartEffect":
        return "Restart";
      case "task":
        return "Init";
      default:
        return "Runtime";
    }
  }

  #mapErrorCode(cause: unknown): ErrorCode {
    if (cause instanceof Error && cause.message.includes("already exists")) {
      return "TASK_ALREADY_EXISTS";
    }
    return "RUNTIME_ERROR";
  }

  #logFailure(failure: InsereFailure): void {
    const logger = this.#logger;

    if (logger === undefined) {
      return;
    }

    let data: Record<string, unknown> | undefined;
    const requestId = this.#currentRequestId();

    if (failure.data !== undefined) {
      data = { ...failure.data };
    }

    if (failure.wait !== undefined) {
      data ??= {};
      data.wait = failure.wait;
    }

    if (failure.attempts !== undefined) {
      data ??= {};
      data.attempts = failure.attempts;
    }

    logInsereBug({
      logger,
      operation: failure.operation,
      cause: failure.cause,
      runtime: failure.runtime,
      stage: failure.stage,
      event: `${failure.stage}_${failure.operation}_Failed`,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(failure.key !== undefined ? { key: failure.key } : {}),
      ...(failure.policy !== undefined ? { policy: failure.policy } : {}),
      frame: failure.frame,
      now: failure.now,
      ...(failure.delta !== undefined ? { delta: failure.delta } : {}),
      ...(data !== undefined ? { data } : {})
    });
  }

  #logBug(
    operation: InsereFailureOperation,
    cause: unknown,
    key?: string,
    policy?: string,
    data?: Readonly<Record<string, unknown>>
  ): void {
    if (this.#logger === undefined) {
      return;
    }

    this.#logFailure(this.#failure(operation, cause, key, policy, data));
  }

  #drainReportedFailures(): InsereFailure | undefined {
    let first: InsereFailure | undefined;
    const failures = this.#pendingFailures;

    try {
      for (let index = 0; index < failures.length; index += 1) {
        const failure = failures[index]!;
        first ??= failure;
        this.#logFailure(failure);
        this.#supervise(failure);
      }
    } finally {
      failures.length = 0;
    }

    return first;
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
      const logger = this.#logger;

      if (logger === undefined) {
        return;
      }

      const requestId = this.#currentRequestId();

      logInsereBug({
        logger,
        operation: failure.operation,
        cause: error,
        runtime: "api",
        stage: "Supervise",
        event: "Supervise_FailureReporter_Failed",
        ...(requestId !== undefined ? { requestId } : {}),
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

  #currentRequestId(): string | undefined {
    try {
      return typeof this.#requestId === "function"
        ? this.#requestId()
        : this.#requestId;
    } catch {
      return undefined;
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
          this.#logFailure(this.#failure(failure.operation, failure.cause, failure.key, failure.policy, {
            supervision: "dispatchAndStop",
            reason: "missingToEvent"
          }));
          return;
        }

        try {
          this.#dispatch(this.#supervision.toEvent(failure));
        } catch (error) {
          this.#logFailure(this.#failure(failure.operation, error, failure.key, failure.policy, {
            supervision: "dispatchAndStop",
            originalCause: failure.cause
          }));
        }
        return;
      case "convertToResult":
        try {
          this.#supervision.onResult?.(failureResult(failure));
        } catch (error) {
          this.#logFailure(this.#failure(failure.operation, error, failure.key, failure.policy, {
            supervision: "convertToResult",
            originalCause: failure.cause
          }));
        }
        return;
      case "restart":
        if (this.#restartFailedTask(failure)) {
          return;
        }

        this.#pruneCompletedTasks();
        return;
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
        ...this.#failure(failure.operation, error, item.key, undefined, {
          attempts: item.attempts
        }),
        runtime: item.runtime,
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

  /**
   * @deprecated Use applyDirectResult for Result-first host code or
   * applyDirectUnsafe when exceptions are intentional.
   */
  applyDirect(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy,
    start?: DirectInsereTaskStart
  ): boolean {
    return this.applyDirectUnsafe(parts, step, policy, start);
  }

  applyDirectUnsafe(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy,
    start?: DirectInsereTaskStart
  ): boolean {
    return this.#api.applyDirectUnsafe(this.#key(parts), step, policy, start);
  }

  applyDirectResult(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy,
    start?: DirectInsereTaskStart
  ): InsereTaskApplyResult {
    return this.#api.applyDirectResult(this.#key(parts), step, policy, start);
  }

  /**
   * @deprecated Use applyDirectResult(..., "restart", "frame") or
   * waitFrameUnsafe when exceptions are intentional.
   */
  waitFrame(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.waitFrameUnsafe(parts, step, policy);
  }

  waitFrameUnsafe(
    parts: string | readonly string[],
    step: DirectInsereStep<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): boolean {
    return this.#api.waitFrameUnsafe(this.#key(parts), step, policy);
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
    return this.#api.frameLoopUnsafe(this.#key(parts), step, policy);
  }

  frameLoopResult(
    parts: string | readonly string[],
    step: DirectInsereFrameLoopStep<TState, TEvent>,
    policy?: InsereTaskPolicy
  ): InsereTaskApplyResult {
    return this.#api.frameLoopResult(this.#key(parts), step, policy);
  }

  /**
   * @deprecated Use applyEffectResult for Result-first host code or
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
    return this.#api.applyEffectUnsafe(this.#key(parts), source, policy);
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
  appError,
  toAppError,
  type AppError,
  type AppErrorOptions,
  type ErrorCode,
  type InsereResult,
  type Stage
} from "./effect.js";
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
