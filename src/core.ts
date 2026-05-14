export type DirectInsereDispatch<TEvent = unknown> = (event: TEvent) => void;
export type DirectInsereStateReader<TState = unknown> = () => TState;
export type DirectInsereWaitKind = "ready" | "frame" | "idle" | "delay";

export interface DirectInsereContext<TState = unknown, TEvent = unknown> {
  readonly key: string;
  readonly frame: number;
  readonly now: number;
  readonly delta: number;
  readonly signal: AbortSignal;
  dispatch(event: TEvent): void;
  getState(): TState;
  onCancel(cleanup: () => void): () => void;
  throwIfCancelled(): void;
  waitFrame(): void;
  waitIdle(): void;
  sleep(ms: number): void;
  sleepUntil(time: number): void;
  complete(): void;
}

export type DirectInsereStep<TState = unknown, TEvent = unknown> = (
  context: DirectInsereContext<TState, TEvent>
) => void;

export interface DirectInsereOptions<TState = unknown, TEvent = unknown> {
  readonly dispatch?: DirectInsereDispatch<TEvent>;
  readonly getState?: DirectInsereStateReader<TState>;
}

export interface DirectInsereEntrySnapshot {
  readonly key: string;
  readonly wait: DirectInsereWaitKind;
}

export interface DirectInsereSnapshot {
  readonly frame: number;
  readonly now: number;
  readonly delta: number;
  readonly size: number;
  readonly entries: readonly DirectInsereEntrySnapshot[];
}

interface Entry<TState, TEvent> {
  readonly key: string;
  step: DirectInsereStep<TState, TEvent>;
  readonly groups: string[] | undefined;
  aborted: boolean;
  controller: AbortController | undefined;
  finalizers: (() => void) | Set<() => void> | undefined;
  queuedFrame: boolean;
  wait: DirectInsereWaitKind | "done";
  waitFrame: number;
  wakeAt: number;
}

export class DirectInsereTask<TState = unknown, TEvent = unknown> {
  readonly #entries = new Map<string, Entry<TState, TEvent>>();
  readonly #groups = new Map<string, Set<string>>();
  readonly #context: DirectInsereContext<TState, TEvent>;
  readonly #dispatch: DirectInsereDispatch<TEvent>;
  readonly #getState: DirectInsereStateReader<TState>;
  #frameQueue: Entry<TState, TEvent>[] = [];
  #queuedFrameCount = 0;
  #structureVersion = 0;
  #activeEntry: Entry<TState, TEvent> | undefined;
  #soleEntry: Entry<TState, TEvent> | undefined;
  #frame = 0;
  #now = 0;
  #previousNow = 0;
  #delta = 0;

  constructor(options: DirectInsereOptions<TState, TEvent> = {}) {
    this.#dispatch = options.dispatch ?? (() => undefined);
    this.#getState = options.getState ?? (() => undefined as TState);
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

  snapshot(): DirectInsereSnapshot {
    return {
      frame: this.#frame,
      now: this.#now,
      delta: this.#delta,
      size: this.#entries.size,
      entries: [...this.#entries.values()].map((entry) => ({
        key: entry.key,
        wait: entry.wait === "done" ? "ready" : entry.wait
      }))
    };
  }

  spawn(key: string, step: DirectInsereStep<TState, TEvent>): void {
    this.#assertKey(key);
    if (this.#entries.has(key)) {
      throw new Error(`DirectInsereTask already exists: ${key}`);
    }

    const entry = this.#createEntry(key, step);
    this.#setEntry(entry);
    this.#run(entry);
  }

  restart(key: string, step: DirectInsereStep<TState, TEvent>): void {
    this.#assertKey(key);
    const previous = this.#entries.get(key);

    if (!previous) {
      const entry = this.#createEntry(key, step);
      this.#setEntry(entry);
      this.#run(entry);
      return;
    }

    this.#cancelEntry(previous);

    if (previous.finalizers) {
      this.#deleteEntry(previous);
      this.#runFinalizers(previous);
      const entry = this.#createEntry(key, step);
      this.#setEntry(entry);
      this.#run(entry);
      return;
    }

    this.#unqueueFrame(previous);
    previous.step = step;
    previous.aborted = false;
    previous.controller = undefined;
    previous.wait = "ready";
    previous.waitFrame = 0;
    previous.wakeAt = 0;
    this.#run(previous);
  }

  waitFrame(key: string, step: DirectInsereStep<TState, TEvent>): void {
    this.#assertKey(key);
    if (this.#entries.has(key)) {
      throw new Error(`DirectInsereTask already exists: ${key}`);
    }

    const entry = this.#createEntry(key, step);
    entry.wait = "frame";
    entry.waitFrame = this.#frame;
    this.#setEntry(entry);
    this.#queueFrame(entry);
  }

  cancel(key: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) {
      return false;
    }

    this.#cancelEntry(entry);
    this.#deleteEntry(entry);
    this.#runFinalizers(entry);
    return true;
  }

  cancelGroup(prefix: string): number {
    if (prefix.length === 0) {
      throw new Error("DirectInsereTask cancelGroup prefix must not be empty.");
    }

    if (this.#entries.size === 0) {
      return 0;
    }

    const group = this.#groups.get(prefix);
    if (group) {
      if (group.size === this.#entries.size) {
        return this.#cancelAllEntries();
      }

      let count = 0;

      for (const key of group) {
        const entry = this.#entries.get(key);

        if (entry) {
          this.#cancelEntry(entry);
          this.#deleteEntry(entry);
          this.#runFinalizers(entry);
          count += 1;
        }
      }

      return count;
    }

    let allMatch = true;
    for (const key of this.#entries.keys()) {
      if (!key.startsWith(prefix)) {
        allMatch = false;
        break;
      }
    }

    if (allMatch) {
      return this.#cancelAllEntries();
    }

    let count = 0;

    for (const [key, entry] of this.#entries) {
      if (key.startsWith(prefix)) {
        this.#cancelEntry(entry);
        this.#deleteEntry(entry);
        this.#runFinalizers(entry);
        count += 1;
      }
    }

    return count;
  }

  cancelAll(): void {
    this.#cancelAllEntries();
  }

  tick(now: number): void {
    if (!Number.isFinite(now)) {
      throw new RangeError(`Invalid tick time: ${now}`);
    }

    this.#previousNow = this.#now;
    this.#now = now;
    this.#delta = this.#frame === 0 ? 0 : now - this.#previousNow;
    this.#frame += 1;

    if (this.#frameQueue.length > 0) {
      const frameQueue = this.#frameQueue;
      const onlyFrameWaiters = this.#queuedFrameCount === this.#entries.size;
      const structureVersion = this.#structureVersion;
      const entryCount = this.#entries.size;
      let doneCount = 0;
      this.#frameQueue = [];

      for (const entry of frameQueue) {
        if (
          entry.queuedFrame &&
          entry.wait === "frame" &&
          this.#frame > entry.waitFrame
        ) {
          this.#unqueueFrame(entry);
          this.#run(entry, !onlyFrameWaiters);

          const wait = entry.wait as DirectInsereWaitKind | "done";
          if (
            onlyFrameWaiters &&
            wait === "done"
          ) {
            doneCount += 1;
          }
        }
      }

      if (onlyFrameWaiters) {
        if (
          doneCount === entryCount &&
          this.#structureVersion === structureVersion
        ) {
          this.#entries.clear();
          this.#groups.clear();
          this.#soleEntry = undefined;
          this.#structureVersion += 1;
        } else {
          for (const entry of frameQueue) {
            const wait = entry.wait as DirectInsereWaitKind | "done";

            if (wait === "done") {
              this.#deleteEntry(entry);
            }
          }
        }

        return;
      }
    }

    if (this.#soleEntry) {
      this.#runIfReady(this.#soleEntry);
      return;
    }

    for (const entry of this.#entries.values()) {
      this.#runIfReady(entry);
    }
  }

  runIdle(): void {
    if (this.#soleEntry) {
      if (this.#soleEntry.wait === "idle") {
        this.#run(this.#soleEntry);
      }
      return;
    }

    for (const entry of this.#entries.values()) {
      if (entry.wait === "idle") {
        this.#run(entry);
      }
    }
  }

  #createEntry(
    key: string,
    step: DirectInsereStep<TState, TEvent>
  ): Entry<TState, TEvent> {
    return {
      key,
      step,
      groups: this.#groupPrefixes(key),
      aborted: false,
      controller: undefined,
      finalizers: undefined,
      queuedFrame: false,
      wait: "ready",
      waitFrame: 0,
      wakeAt: 0
    };
  }

  #createContext(): DirectInsereContext<TState, TEvent> {
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
        const entry = runtime.#requireActiveEntry();
        entry.controller ??= new AbortController();

        if (entry.aborted) {
          entry.controller.abort();
        }

        return entry.controller.signal;
      },
      dispatch: (event) => this.#dispatch(event),
      getState: () => this.#getState(),
      onCancel: (cleanup) => {
        const entry = runtime.#requireActiveEntry();

        if (!entry.finalizers) {
          entry.finalizers = cleanup;
        } else if (typeof entry.finalizers === "function") {
          entry.finalizers = new Set([entry.finalizers, cleanup]);
        } else {
          entry.finalizers.add(cleanup);
        }

        return () => {
          if (entry.finalizers === cleanup) {
            entry.finalizers = undefined;
            return;
          }

          if (entry.finalizers && typeof entry.finalizers !== "function") {
            entry.finalizers.delete(cleanup);
          }
        };
      },
      throwIfCancelled: () => {
        if (runtime.#requireActiveEntry().aborted) {
          throw new DOMException("DirectInsereTask was cancelled.", "AbortError");
        }
      },
      waitFrame: () => {
        const entry = runtime.#requireActiveEntry();
        entry.wait = "frame";
        entry.waitFrame = this.#frame;
        runtime.#queueFrame(entry);
      },
      waitIdle: () => {
        runtime.#requireActiveEntry().wait = "idle";
      },
      sleep: (ms) => {
        if (!Number.isFinite(ms) || ms < 0) {
          throw new RangeError(`Invalid sleep: ${ms}`);
        }

        const entry = runtime.#requireActiveEntry();
        entry.wait = "delay";
        entry.wakeAt = this.#now + ms;
      },
      sleepUntil: (time) => {
        if (!Number.isFinite(time)) {
          throw new RangeError(`Invalid wake time: ${time}`);
        }

        const entry = runtime.#requireActiveEntry();
        entry.wait = "delay";
        entry.wakeAt = time;
      },
      complete: () => {
        runtime.#requireActiveEntry().wait = "done";
      }
    };
  }

  #runIfReady(entry: Entry<TState, TEvent>): void {
    switch (entry.wait) {
      case "ready":
        this.#run(entry);
        return;
      case "frame":
        if (this.#frame > entry.waitFrame) {
          this.#unqueueFrame(entry);
          this.#run(entry);
        }
        return;
      case "idle":
        return;
      case "delay":
        if (this.#now >= entry.wakeAt) {
          this.#run(entry);
        }
        return;
      case "done":
        this.#deleteEntry(entry);
        return;
    }
  }

  #run(entry: Entry<TState, TEvent>, deleteOnDone = true): void {
    if (entry.aborted) {
      return;
    }

    entry.wait = "done";
    this.#activeEntry = entry;

    try {
      entry.step(this.#context);
      this.#activeEntry = undefined;

      if (deleteOnDone && entry.wait === "done") {
        this.#deleteEntry(entry);
      }
    } catch (error) {
      this.#activeEntry = undefined;
      this.#cancelEntry(entry);
      this.#deleteEntry(entry);
      throw error;
    }
  }

  #cancelEntry(entry: Entry<TState, TEvent>): void {
    entry.aborted = true;
    entry.controller?.abort();
  }

  #runFinalizers(entry: Entry<TState, TEvent>): void {
    if (!entry.finalizers) {
      return;
    }

    const finalizers = entry.finalizers;
    entry.finalizers = undefined;

    this.#activeEntry = entry;
    try {
      if (typeof finalizers === "function") {
        finalizers();
      } else {
        const callbacks = [...finalizers].reverse();

        for (const cleanup of callbacks) {
          cleanup();
        }
      }
    } finally {
      this.#activeEntry = undefined;
    }
  }

  #setEntry(entry: Entry<TState, TEvent>): void {
    this.#entries.set(entry.key, entry);
    this.#addGroups(entry);
    this.#soleEntry = this.#entries.size === 1 ? entry : undefined;
    this.#structureVersion += 1;
  }

  #deleteEntry(entry: Entry<TState, TEvent>): void {
    if (this.#entries.get(entry.key) !== entry) {
      return;
    }

    this.#unqueueFrame(entry);
    this.#entries.delete(entry.key);
    this.#removeGroups(entry);
    this.#structureVersion += 1;

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

  #cancelAllEntries(): number {
    const count = this.#entries.size;

    for (const entry of this.#entries.values()) {
      this.#cancelEntry(entry);
      this.#unqueueFrame(entry);
      this.#runFinalizers(entry);
    }

    this.#entries.clear();
    this.#groups.clear();
    this.#frameQueue = [];
    this.#queuedFrameCount = 0;
    this.#soleEntry = undefined;
    this.#structureVersion += 1;
    return count;
  }

  #queueFrame(entry: Entry<TState, TEvent>): void {
    if (entry.queuedFrame) {
      return;
    }

    entry.queuedFrame = true;
    this.#queuedFrameCount += 1;
    this.#frameQueue.push(entry);
  }

  #unqueueFrame(entry: Entry<TState, TEvent>): void {
    if (!entry.queuedFrame) {
      return;
    }

    entry.queuedFrame = false;
    this.#queuedFrameCount -= 1;
  }

  #assertKey(key: string): void {
    if (key.length === 0) {
      throw new Error("DirectInsereTask key must not be empty.");
    }
  }

  #groupPrefixes(key: string): string[] | undefined {
    const firstColon = key.indexOf(":");

    if (firstColon === -1) {
      return undefined;
    }

    const groups = [key.slice(0, firstColon + 1)];

    for (let index = firstColon + 1; index < key.length; index += 1) {
      if (key.charCodeAt(index) === 58) {
        groups.push(key.slice(0, index + 1));
      }
    }

    return groups;
  }

  #addGroups(entry: Entry<TState, TEvent>): void {
    if (!entry.groups) {
      return;
    }

    for (const group of entry.groups) {
      let keys = this.#groups.get(group);

      if (!keys) {
        keys = new Set();
        this.#groups.set(group, keys);
      }

      keys.add(entry.key);
    }
  }

  #removeGroups(entry: Entry<TState, TEvent>): void {
    if (!entry.groups) {
      return;
    }

    for (const group of entry.groups) {
      const keys = this.#groups.get(group);

      if (!keys) {
        continue;
      }

      keys.delete(entry.key);

      if (keys.size === 0) {
        this.#groups.delete(group);
      }
    }
  }

  #requireActiveEntry(): Entry<TState, TEvent> {
    if (!this.#activeEntry) {
      throw new Error("DirectInsereTask context is only valid while a task is running.");
    }

    return this.#activeEntry;
  }
}

export { DirectInsereTask as InsereCore };
