export type InsereLogLevel = "debug" | "info" | "warn" | "error";

export type InsereLogKind = "bug" | "runtime" | "policy";

export type InsereLogRuntime = "api" | "direct" | "effect";

export interface InsereLogRecord {
  readonly ts: string;
  readonly level: InsereLogLevel;
  readonly kind: InsereLogKind;
  readonly runtime: InsereLogRuntime;
  readonly stage: string;
  readonly event: string;
  readonly requestId?: string | undefined;
  readonly operation: string;
  readonly message: string;
  readonly key?: string | undefined;
  readonly policy?: string | undefined;
  readonly frame?: number | undefined;
  readonly now?: number | undefined;
  readonly delta?: number | undefined;
  readonly cause?: unknown | undefined;
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}

export type InsereLogger = (record: InsereLogRecord) => void;

export interface InsereBugLogOptions {
  readonly logger?: InsereLogger;
  readonly runtime?: InsereLogRuntime;
  readonly stage: string;
  readonly event: string;
  readonly requestId?: string | undefined;
  readonly operation: string;
  readonly cause: unknown;
  readonly key?: string | undefined;
  readonly policy?: string | undefined;
  readonly frame?: number | undefined;
  readonly now?: number | undefined;
  readonly delta?: number | undefined;
  readonly message?: string | undefined;
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}

export interface BufferedInsereLogger {
  readonly records: readonly InsereLogRecord[];
  readonly logger: InsereLogger;
  clear(): void;
}

export interface InsereConsoleLike {
  error(...data: unknown[]): void;
  warn?(...data: unknown[]): void;
  info?(...data: unknown[]): void;
  log?(...data: unknown[]): void;
}

export function logInsereBug(options: InsereBugLogOptions): void {
  const { logger } = options;

  if (!logger) {
    return;
  }

  const record: InsereLogRecord = {
    ts: new Date().toISOString(),
    level: "error",
    kind: "bug",
    runtime: options.runtime ?? "api",
    stage: options.stage,
    event: options.event,
    operation: options.operation,
    message:
      options.message ??
      `Insere bug while running ${options.operation}.`,
    cause: options.cause,
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    ...(options.key !== undefined ? { key: options.key } : {}),
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
    ...(options.frame !== undefined ? { frame: options.frame } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.delta !== undefined ? { delta: options.delta } : {}),
    ...(options.data !== undefined ? { data: options.data } : {})
  };

  try {
    logger(record);
  } catch {
    // Logging must never hide the original task/runtime failure.
  }
}

export function createBufferedInsereLogger(
  limit = 100
): BufferedInsereLogger {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("Insere buffered logger limit must be a positive integer.");
  }

  const records: InsereLogRecord[] = [];

  return {
    get records() {
      return records;
    },
    logger(record) {
      if (records.length >= limit) {
        records.shift();
      }

      records.push(record);
    },
    clear() {
      records.length = 0;
    }
  };
}

export function createConsoleInsereLogger(
  target: InsereConsoleLike = console
): InsereLogger {
  return (record) => {
    const write =
      record.level === "error"
        ? target.error
        : record.level === "warn"
          ? target.warn ?? target.error
          : target.info ?? target.log ?? target.error;

    write.call(target, JSON.stringify(record));
  };
}
