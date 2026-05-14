import { err, type InsereResult } from "./effect.js";

export type InsereRuntimeKind = "api" | "direct" | "effect";

export type InsereFailureOperation =
  | "applyDirectResult"
  | "applyEffectResult"
  | "cancel"
  | "cancelAll"
  | "cancelGroup"
  | "restartDirect"
  | "restartEffect"
  | "runIdle"
  | "task"
  | "tick";

export type InsereSupervisionPolicy =
  | "bubble"
  | "logAndStop"
  | "dispatchAndStop"
  | "convertToResult"
  | "restart";

export interface InsereFailure {
  readonly runtime: InsereRuntimeKind;
  readonly operation: InsereFailureOperation;
  readonly key?: string;
  readonly wait?: string;
  readonly policy?: string;
  readonly frame: number;
  readonly now: number;
  readonly delta?: number;
  readonly cause: unknown;
  readonly attempts?: number;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface InsereSupervisionOptions<TEvent = unknown> {
  readonly policy?: InsereSupervisionPolicy;
  readonly maxRestarts?: number;
  readonly toEvent?: (failure: InsereFailure) => TEvent;
  readonly onFailure?: (failure: InsereFailure) => void;
  readonly onResult?: (result: InsereResult<never, InsereFailure>) => void;
}

export interface NormalizedInsereSupervision<TEvent = unknown> {
  readonly policy: InsereSupervisionPolicy;
  readonly maxRestarts: number;
  readonly toEvent?: (failure: InsereFailure) => TEvent;
  readonly onFailure?: (failure: InsereFailure) => void;
  readonly onResult?: (result: InsereResult<never, InsereFailure>) => void;
}

export function normalizeInsereSupervision<TEvent>(
  options: InsereSupervisionOptions<TEvent> | undefined
): NormalizedInsereSupervision<TEvent> {
  const maxRestarts = options?.maxRestarts ?? 0;

  if (!Number.isInteger(maxRestarts) || maxRestarts < 0) {
    throw new RangeError("Insere supervision maxRestarts must be a non-negative integer.");
  }

  return {
    policy: options?.policy ?? "bubble",
    maxRestarts,
    ...(options?.toEvent !== undefined ? { toEvent: options.toEvent } : {}),
    ...(options?.onFailure !== undefined ? { onFailure: options.onFailure } : {}),
    ...(options?.onResult !== undefined ? { onResult: options.onResult } : {})
  };
}

export function failureResult(
  failure: InsereFailure
): InsereResult<never, InsereFailure> {
  return err(failure);
}
