import { asyncEffect, type InsereEffect } from "./effect.js";

export type InsereMailboxBufferPolicy = "drop" | "latest" | "queue" | "bounded";
export type InsereMailboxOverflowPolicy = "drop-oldest" | "drop-newest" | "throw";
export type InsereEventMatcher<TEvent> = (event: TEvent) => boolean;

export interface InsereMailboxOptions {
  readonly buffer?: InsereMailboxBufferPolicy;
  readonly capacity?: number;
  readonly overflow?: InsereMailboxOverflowPolicy;
}

export interface InsereMailboxWaitOptions {
  readonly signal?: AbortSignal;
}

type ResolveFn<TEvent> = (event: TEvent) => void;
type WaiterSlot<TEvent> = ResolveFn<TEvent> | Waiter<TEvent> | undefined;

interface Waiter<TEvent> {
  match: InsereEventMatcher<TEvent> | undefined;
  resolve: (event: TEvent) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  abort: (() => void) | undefined;
  removed: boolean;
}

export class InsereMailbox<TEvent = unknown> {
  readonly #buffer: InsereMailboxBufferPolicy;
  readonly #capacity: number;
  readonly #overflow: InsereMailboxOverflowPolicy;
  readonly #events: TEvent[] = [];
  #waiters: WaiterSlot<TEvent>[] = [];
  #waiterHead = 0;
  #activeWaiters = 0;
  #removedWaiters = 0;

  constructor(options: InsereMailboxOptions = {}) {
    this.#buffer = options.buffer ?? "drop";
    this.#capacity = options.capacity ?? 128;
    this.#overflow = options.overflow ?? "drop-oldest";

    if (!Number.isInteger(this.#capacity) || this.#capacity < 1) {
      throw new RangeError("Insere mailbox capacity must be a positive integer.");
    }
  }

  get size(): number {
    return this.#events.length;
  }

  get waiters(): number {
    return this.#activeWaiters;
  }

  clear(): void {
    this.#events.length = 0;
  }

  emit(event: TEvent): number {
    const waiters = this.#waiters;
    const length = waiters.length;

    if (length === 0) {
      this.#bufferEvent(event);
      return 0;
    }

    if (this.#activeWaiters === 0) {
      this.#clearWaiters();
      this.#bufferEvent(event);
      return 0;
    }

    let delivered = 0;
    let kept = 0;

    for (let i = this.#waiterHead; i < length; i += 1) {
      const waiter = waiters[i]!;

      if (waiter === undefined) {
        continue;
      }

      if (typeof waiter === "function") {
        this.#resolveWaiter(waiter, event);
        delivered += 1;
        continue;
      }

      if (waiter.removed) {
        continue;
      }

      const match = waiter.match;
      if (match !== undefined && !match(event)) {
        if (kept !== i) {
          waiters[kept] = waiter;
        }
        kept += 1;
        continue;
      }

      this.#resolveWaiter(waiter, event);
      delivered += 1;
    }

    if (kept === 0) {
      waiters.length = 0;
    } else {
      waiters.length = kept;
    }
    this.#waiterHead = 0;
    this.#removedWaiters = 0;

    if (delivered === 0) {
      this.#bufferEvent(event);
    }

    return delivered;
  }

  emitOne(event: TEvent): number {
    const waiters = this.#waiters;
    const length = waiters.length;

    if (length === 0) {
      this.#bufferEvent(event);
      return 0;
    }

    if (this.#activeWaiters === 0) {
      this.#clearWaiters();
      this.#bufferEvent(event);
      return 0;
    }

    for (let index = this.#waiterHead; index < length; index += 1) {
      const waiter = waiters[index]!;

      if (waiter === undefined) {
        continue;
      }

      if (typeof waiter === "function") {
        waiters[index] = undefined;
        this.#resolveWaiter(waiter, event);
        this.#advanceWaiterHead(index);
        this.#compactWaitersIfSparse();
        return 1;
      }

      if (waiter.removed) {
        continue;
      }

      const match = waiter.match;
      if (match !== undefined && !match(event)) {
        continue;
      }

      this.#resolveWaiter(waiter, event);
      this.#advanceWaiterHead(index);
      this.#compactWaitersIfSparse();
      return 1;
    }

    this.#bufferEvent(event);
    return 0;
  }

  wait(
    match?: InsereEventMatcher<TEvent>,
    options?: InsereMailboxWaitOptions
  ): Promise<TEvent> {
    if (this.#events.length > 0) {
      if (match === undefined) {
        const event = this.#events.shift() as TEvent;
        return Promise.resolve(event);
      }

      const bufferedIndex = this.#events.findIndex(match);
      if (bufferedIndex !== -1) {
        const [event] = this.#events.splice(bufferedIndex, 1);
        return Promise.resolve(event as TEvent);
      }
    }

    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(this.#abortError());
    }

    if (match === undefined && signal === undefined) {
      return new Promise<TEvent>((resolve) => {
        this.#waiters.push(resolve);
        this.#activeWaiters += 1;
      });
    }

    return new Promise<TEvent>((resolve, reject) => {
      const waiter: Waiter<TEvent> = {
        match,
        resolve,
        reject,
        signal,
        abort: undefined,
        removed: false
      };

      if (signal !== undefined) {
        const abort = () => {
          if (waiter.removed) {
            return;
          }
          waiter.removed = true;
          this.#activeWaiters -= 1;
          this.#removedWaiters += 1;
          waiter.reject(this.#abortError());
          this.#advanceWaiterHead(this.#waiterHead);
          this.#compactWaitersIfSparse();
        };
        waiter.abort = abort;
        signal.addEventListener("abort", abort as EventListener, { once: true });
      }

      this.#waiters.push(waiter);
      this.#activeWaiters += 1;
    });
  }

  waitEffect<TState = unknown, TDispatchEvent = unknown>(
    match?: InsereEventMatcher<TEvent>
  ): InsereEffect<TState, TDispatchEvent, TEvent> {
    return waitEvent(this, match);
  }

  #bufferEvent(event: TEvent): void {
    switch (this.#buffer) {
      case "drop":
        return;
      case "latest":
        this.#events.length = 0;
        this.#events.push(event);
        return;
      case "queue":
        this.#events.push(event);
        return;
      case "bounded":
        if (this.#events.length < this.#capacity) {
          this.#events.push(event);
          return;
        }

        switch (this.#overflow) {
          case "drop-oldest":
            this.#events.shift();
            this.#events.push(event);
            return;
          case "drop-newest":
            return;
          case "throw":
            throw new Error("Insere mailbox capacity exceeded.");
        }
    }
  }

  #resolveWaiter(waiter: ResolveFn<TEvent> | Waiter<TEvent>, event: TEvent): void {
    if (typeof waiter === "function") {
      this.#activeWaiters -= 1;
      this.#removedWaiters += 1;
      waiter(event);
      return;
    }

    waiter.removed = true;
    this.#activeWaiters -= 1;
    this.#removedWaiters += 1;

    const signal = waiter.signal;
    const abort = waiter.abort;
    if (signal !== undefined && abort !== undefined) {
      signal.removeEventListener("abort", abort as EventListener);
    }

    waiter.resolve(event);
  }

  #compactWaitersIfSparse(): void {
    if (this.#activeWaiters === 0) {
      this.#clearWaiters();
      return;
    }

    if (this.#removedWaiters < 64) {
      return;
    }

    if (this.#removedWaiters <= this.#activeWaiters) {
      return;
    }

    this.#compactWaiters();
  }

  #compactWaiters(): void {
    const waiters = this.#waiters;
    let kept = 0;

    for (let index = this.#waiterHead; index < waiters.length; index += 1) {
      const waiter = waiters[index]!;

      if (waiter === undefined || (typeof waiter !== "function" && waiter.removed)) {
        continue;
      }

      if (kept !== index) {
        waiters[kept] = waiter;
      }
      kept += 1;
    }

    waiters.length = kept;
    this.#waiterHead = 0;
    this.#removedWaiters = 0;
  }

  #clearWaiters(): void {
    this.#waiters.length = 0;
    this.#waiterHead = 0;
    this.#removedWaiters = 0;
  }

  #advanceWaiterHead(index: number): void {
    if (index !== this.#waiterHead) {
      return;
    }

    const waiters = this.#waiters;
    let next = index + 1;

    while (next < waiters.length && isRemovedWaiterSlot(waiters[next])) {
      next += 1;
    }

    this.#waiterHead = next;
  }

  #abortError(): DOMException {
    return new DOMException("Insere mailbox wait was cancelled.", "AbortError");
  }
}

function isRemovedWaiterSlot<TEvent>(slot: WaiterSlot<TEvent>): boolean {
  return slot === undefined || (typeof slot !== "function" && slot.removed);
}

export function createInsereMailbox<TEvent = unknown>(
  options: InsereMailboxOptions = {}
): InsereMailbox<TEvent> {
  return new InsereMailbox(options);
}

export function waitEvent<
  TEvent,
  TState = unknown,
  TDispatchEvent = unknown
>(
  mailbox: InsereMailbox<TEvent>,
  match?: InsereEventMatcher<TEvent>
): InsereEffect<TState, TDispatchEvent, TEvent> {
  return asyncEffect((context) => mailbox.wait(match, { signal: context.signal }));
}
