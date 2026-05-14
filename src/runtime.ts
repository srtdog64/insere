import {
  INSERE_INSTRUCTION_DELAY,
  INSERE_INSTRUCTION_FRAME,
  INSERE_INSTRUCTION_IDLE,
  INSERE_INSTRUCTION_PROMISE,
  type InsereInstruction
} from "./instruction.js";
import type { InsereFailure } from "./supervision.js";

export type InsereDispatch<TEvent = unknown> = (event: TEvent) => void;
export type InsereStateReader<TState = unknown> = () => TState;

export interface InsereContext<TState = unknown, TEvent = unknown> {
  readonly key: string;
  readonly frame: number;
  readonly now: number;
  readonly delta: number;
  readonly signal: AbortSignal;
  dispatch(event: TEvent): void;
  getState(): TState;
  onCancel(cleanup: () => void): () => void;
  throwIfCancelled(): void;
}

export type InsereRoutine<TState = unknown, TEvent = unknown> = Generator<
  InsereInstruction,
  void,
  unknown
>;

export type InsereRoutineFactory<TState = unknown, TEvent = unknown> = (
  context: InsereContext<TState, TEvent>
) => InsereRoutine<TState, TEvent>;

export interface InsereOptions<TState = unknown, TEvent = unknown> {
  readonly dispatch?: InsereDispatch<TEvent>;
  readonly getState?: InsereStateReader<TState>;
  readonly onFailure?: (failure: InsereFailure) => void;
}

export type InsereWaitKind = "ready" | "frame" | "idle" | "delay" | "promise";

const WAIT_READY = 0;
const WAIT_FRAME = 1;
const WAIT_IDLE = 2;
const WAIT_DELAY = 3;
const WAIT_PROMISE = 4;

type WaitCode =
  | typeof WAIT_READY
  | typeof WAIT_FRAME
  | typeof WAIT_IDLE
  | typeof WAIT_DELAY
  | typeof WAIT_PROMISE;

const WAIT_KIND: readonly InsereWaitKind[] = [
  "ready",
  "frame",
  "idle",
  "delay",
  "promise"
];

export interface InsereEntrySnapshot {
  readonly key: string;
  readonly wait: InsereWaitKind;
}

export interface InsereSnapshot {
  readonly frame: number;
  readonly now: number;
  readonly delta: number;
  readonly size: number;
  readonly entries: readonly InsereEntrySnapshot[];
}

interface PromiseToken {
  status: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  error?: unknown;
}

interface Entry<TState, TEvent> {
  readonly key: string;
  routine: InsereRoutine<TState, TEvent>;
  aborted: boolean;
  controller: AbortController | undefined;
  finalizers: Set<() => void> | undefined;
  wait: WaitCode;
  waitFrame: number;
  wakeAt: number;
  promiseToken: PromiseToken | undefined;
}

export class Insere<TState = unknown, TEvent = unknown> {
  readonly #entries = new Map<string, Entry<TState, TEvent>>();
  readonly #dispatch: InsereDispatch<TEvent>;
  readonly #getState: InsereStateReader<TState>;
  readonly #onFailure: ((failure: InsereFailure) => void) | undefined;
  readonly #context: InsereContext<TState, TEvent>;
  #activeEntry: Entry<TState, TEvent> | undefined;
  #soleEntry: Entry<TState, TEvent> | undefined;
  #frame = 0;
  #now = 0;
  #previousNow = 0;
  #delta = 0;

  constructor(options: InsereOptions<TState, TEvent> = {}) {
    this.#dispatch = options.dispatch ?? (() => undefined);
    this.#getState = options.getState ?? (() => undefined as TState);
    this.#onFailure = options.onFailure;
    this.#context = this.#createContext();
  }

  get size(): number {
    return this.#entries.size;
  }

  get frame(): number {
    return this.#frame;
  }

  get now(): number {
    return this.#now;
  }

  get delta(): number {
    return this.#delta;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  keys(): string[] {
    return [...this.#entries.keys()];
  }

  snapshot(): InsereSnapshot {
    return {
      frame: this.#frame,
      now: this.#now,
      delta: this.#delta,
      size: this.#entries.size,
      entries: [...this.#entries.values()].map((entry) => ({
        key: entry.key,
        wait: WAIT_KIND[entry.wait] as InsereWaitKind
      }))
    };
  }

  spawn(key: string, factory: InsereRoutineFactory<TState, TEvent>): void {
    this.#assertKey(key);
    if (this.#entries.has(key)) {
      throw new Error(`Insere routine already exists: ${key}`);
    }

    const entry = this.#createEntry(key, factory);
    this.#setEntry(entry);
    this.#resume(entry);
  }

  restart(key: string, factory: InsereRoutineFactory<TState, TEvent>): void {
    this.#assertKey(key);
    const previous = this.#entries.get(key);

    if (!previous) {
      const entry = this.#createEntry(key, factory);
      this.#setEntry(entry);
      this.#resume(entry);
      return;
    }

    previous.aborted = true;
    previous.controller?.abort();
    this.#runFinalizers(previous);

    previous.aborted = false;
    previous.controller = undefined;
    previous.finalizers = undefined;
    previous.wait = WAIT_READY;
    previous.waitFrame = 0;
    previous.wakeAt = 0;
    previous.promiseToken = undefined;

    previous.routine = factory(this.#context);

    this.#resume(previous);
  }

  cancel(key: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) {
      return false;
    }

    entry.aborted = true;
    entry.controller?.abort();
    this.#deleteEntry(key);
    this.#runFinalizers(entry);
    return true;
  }

  cancelGroup(prefix: string): number {
    if (prefix.length === 0) {
      throw new Error("Insere cancelGroup prefix must not be empty. Use cancelAll() explicitly.");
    }

    let count = 0;

    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix) && this.cancel(key)) {
        count += 1;
      }
    }

    return count;
  }

  cancelAll(): void {
    for (const key of [...this.#entries.keys()]) {
      this.cancel(key);
    }
  }

  tick(now: number): void {
    if (!Number.isFinite(now)) {
      throw new RangeError(`Invalid tick time: ${now}`);
    }

    this.#now = now;
    this.#delta = this.#frame === 0 ? 0 : now - this.#previousNow;
    this.#previousNow = now;
    this.#frame += 1;

    if (this.#soleEntry) {
      this.#resumeIfReady(this.#soleEntry);
      return;
    }

    for (const entry of [...this.#entries.values()]) {
      this.#resumeIfReady(entry);
    }
  }

  runIdle(): void {
    if (this.#soleEntry) {
      const entry = this.#soleEntry;

      if (entry.wait === WAIT_IDLE) {
        entry.wait = WAIT_READY;
        this.#resumeIfReady(entry);
      }

      return;
    }

    for (const entry of [...this.#entries.values()]) {
      if (entry.wait === WAIT_IDLE) {
        entry.wait = WAIT_READY;
        this.#resumeIfReady(entry);
      }
    }
  }

  #createEntry(
    key: string,
    factory: InsereRoutineFactory<TState, TEvent>
  ): Entry<TState, TEvent> {
    const routine = factory(this.#context);
    return {
      key,
      routine,
      aborted: false,
      controller: undefined,
      finalizers: undefined,
      wait: WAIT_READY,
      waitFrame: 0,
      wakeAt: 0,
      promiseToken: undefined
    };
  }

  #createContext(): InsereContext<TState, TEvent> {
    const runtime = this;

    return {
      get key() {
        return runtime.#activeEntry?.key ?? "";
      },
      get frame() {
        return runtime.#frame;
      },
      get now() {
        return runtime.#now;
      },
      get delta() {
        return runtime.#delta;
      },
      get signal() {
        const entry = runtime.#activeEntry;
        if (!entry) {
          throw new Error("Insere context is only valid while a routine is running.");
        }

        entry.controller ??= new AbortController();

        if (entry.aborted) {
          entry.controller.abort();
        }

        return entry.controller.signal;
      },
      dispatch: (event) => this.#dispatch(event),
      getState: () => this.#getState(),
      onCancel: (cleanup) => {
        const entry = runtime.#activeEntry;
        if (!entry) {
          throw new Error("Insere context is only valid while a routine is running.");
        }

        (entry.finalizers ??= new Set()).add(cleanup);
        return () => {
          entry.finalizers?.delete(cleanup);
        };
      },
      throwIfCancelled: () => {
        const entry = runtime.#activeEntry;
        if (!entry) {
          throw new Error("Insere context is only valid while a routine is running.");
        }

        if (entry.aborted) {
          throw new DOMException("Insere routine was cancelled.", "AbortError");
        }
      }
    };
  }

  #resumeIfReady(entry: Entry<TState, TEvent>): void {
    switch (entry.wait) {
      case WAIT_READY:
        entry.wait = WAIT_READY;
        this.#resume(entry);
        return;
      case WAIT_FRAME:
        if (this.#frame > entry.waitFrame) {
          entry.wait = WAIT_READY;
          this.#resume(entry);
        }
        return;
      case WAIT_IDLE:
        return;
      case WAIT_DELAY:
        if (this.#now >= entry.wakeAt) {
          entry.wait = WAIT_READY;
          this.#resume(entry);
        }
        return;
      case WAIT_PROMISE:
        if (!entry.promiseToken) {
          return;
        }

        if (entry.promiseToken.status === "rejected") {
          this.#throw(entry, entry.promiseToken.error);
          return;
        }

        if (entry.promiseToken.status === "fulfilled") {
          const value = entry.promiseToken.value;
          entry.promiseToken = undefined;
          entry.wait = WAIT_READY;
          this.#resume(entry, value);
        }
        return;
    }
  }

  #resume(entry: Entry<TState, TEvent>, value?: unknown): void {
    if (entry.aborted) {
      return;
    }

    this.#activeEntry = entry;
    try {
      const result = entry.routine.next(value);
      this.#activeEntry = undefined;

      if (result.done) {
        this.#deleteEntry(entry.key);
        return;
      }

      this.#setWait(entry, result.value);
    } catch (error) {
      this.#activeEntry = undefined;
      this.#reportFailure(entry, WAIT_READY, error);
      entry.aborted = true;
      entry.controller?.abort();
      this.#deleteEntry(entry.key);
      throw error;
    }
  }

  #throw(entry: Entry<TState, TEvent>, error: unknown): void {
    if (entry.aborted) {
      return;
    }

    this.#activeEntry = entry;
    try {
      const result = entry.routine.throw(error);
      this.#activeEntry = undefined;

      if (result.done) {
        this.#deleteEntry(entry.key);
        return;
      }

      this.#setWait(entry, result.value);
    } catch (thrown) {
      this.#activeEntry = undefined;
      this.#reportFailure(entry, entry.wait, thrown);
      entry.aborted = true;
      entry.controller?.abort();
      this.#deleteEntry(entry.key);
      throw thrown;
    }
  }

  #setWait(entry: Entry<TState, TEvent>, instruction: InsereInstruction): void {
    switch (instruction.op) {
      case INSERE_INSTRUCTION_FRAME:
        entry.wait = WAIT_FRAME;
        entry.waitFrame = this.#frame;
        entry.promiseToken = undefined;
        return;
      case INSERE_INSTRUCTION_IDLE:
        entry.wait = WAIT_IDLE;
        entry.promiseToken = undefined;
        return;
      case INSERE_INSTRUCTION_DELAY:
        entry.wait = WAIT_DELAY;
        entry.wakeAt = this.#now + instruction.ms;
        entry.promiseToken = undefined;
        return;
      case INSERE_INSTRUCTION_PROMISE:
        entry.wait = WAIT_PROMISE;
        entry.promiseToken = this.#trackPromise(instruction.promise);
        return;
      default:
        this.#setWaitByKind(entry, instruction);
    }
  }

  #setWaitByKind(entry: Entry<TState, TEvent>, instruction: InsereInstruction): void {
    switch (instruction.kind) {
      case "frame":
        entry.wait = WAIT_FRAME;
        entry.waitFrame = this.#frame;
        entry.promiseToken = undefined;
        return;
      case "idle":
        entry.wait = WAIT_IDLE;
        entry.promiseToken = undefined;
        return;
      case "delay":
        entry.wait = WAIT_DELAY;
        entry.wakeAt = this.#now + instruction.ms;
        entry.promiseToken = undefined;
        return;
      case "promise":
        entry.wait = WAIT_PROMISE;
        entry.promiseToken = this.#trackPromise(instruction.promise);
        return;
    }
  }

  #trackPromise(promise: Promise<unknown>): PromiseToken {
    const token: PromiseToken = { status: "pending" };

    promise.then(
      (value: unknown) => {
        token.status = "fulfilled";
        token.value = value;
      },
      (error: unknown) => {
        token.status = "rejected";
        token.error = error;
      }
    );

    return token;
  }

  #runFinalizers(entry: Entry<TState, TEvent>): void {
    const callbacks = entry.finalizers;
    if (!callbacks || callbacks.size === 0) {
      return;
    }

    entry.finalizers = undefined;

    const previousActive = this.#activeEntry;
    this.#activeEntry = entry;
    try {
      if (callbacks.size === 1) {
        for (const cleanup of callbacks) {
          cleanup();
        }
        return;
      }

      const finalizers = [...callbacks].reverse();
      for (const cleanup of finalizers) {
        cleanup();
      }
    } finally {
      this.#activeEntry = previousActive;
    }
  }

  #setEntry(entry: Entry<TState, TEvent>): void {
    this.#entries.set(entry.key, entry);
    this.#soleEntry = this.#entries.size === 1 ? entry : undefined;
  }

  #deleteEntry(key: string): void {
    this.#entries.delete(key);

    if (this.#entries.size === 0) {
      this.#soleEntry = undefined;
      return;
    }

    if (this.#entries.size === 1) {
      this.#soleEntry = this.#entries.values().next().value;
      return;
    }

    this.#soleEntry = undefined;
  }

  #assertKey(key: string): void {
    if (key.length === 0) {
      throw new Error("Insere routine key must not be empty.");
    }
  }

  #reportFailure(
    entry: Entry<TState, TEvent>,
    wait: WaitCode,
    cause: unknown
  ): void {
    try {
      this.#onFailure?.({
        code: "RUNTIME_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
        stage: "Runtime",
        runtime: "effect",
        operation: "task",
        key: entry.key,
        wait: WAIT_KIND[wait] as InsereWaitKind,
        frame: this.#frame,
        now: this.#now,
        delta: this.#delta,
        cause
      });
    } catch {
      // Failure reporters must not prevent task cleanup or rethrow semantics.
    }
  }
}
