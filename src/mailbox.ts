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

interface Waiter<TEvent> {
  readonly match: InsereEventMatcher<TEvent>;
  readonly resolve: (event: TEvent) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
}

export class InsereMailbox<TEvent = unknown> {
  readonly #buffer: InsereMailboxBufferPolicy;
  readonly #capacity: number;
  readonly #overflow: InsereMailboxOverflowPolicy;
  readonly #events: TEvent[] = [];
  readonly #waiters = new Set<Waiter<TEvent>>();

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
    return this.#waiters.size;
  }

  clear(): void {
    this.#events.length = 0;
  }

  emit(event: TEvent): number {
    let delivered = 0;

    for (const waiter of this.#waiters) {
      if (!waiter.match(event)) {
        continue;
      }

      this.#deleteWaiter(waiter);
      waiter.resolve(event);
      delivered += 1;
    }

    if (delivered === 0) {
      this.#bufferEvent(event);
    }

    return delivered;
  }

  wait(
    match: InsereEventMatcher<TEvent> = () => true,
    options: InsereMailboxWaitOptions = {}
  ): Promise<TEvent> {
    const bufferedIndex = this.#events.findIndex(match);
    if (bufferedIndex !== -1) {
      const [event] = this.#events.splice(bufferedIndex, 1);
      return Promise.resolve(event as TEvent);
    }

    const { signal } = options;
    if (signal?.aborted) {
      return Promise.reject(this.#abortError());
    }

    return new Promise<TEvent>((resolve, reject) => {
      let waiter: Waiter<TEvent>;
      const abort = signal
        ? () => {
            this.#deleteWaiter(waiter);
            reject(this.#abortError());
          }
        : undefined;

      waiter = {
        match,
        resolve,
        reject,
        signal,
        abort
      };

      signal?.addEventListener("abort", abort as EventListener, { once: true });
      this.#waiters.add(waiter);
    });
  }

  waitEffect(
    match: InsereEventMatcher<TEvent> = () => true
  ): InsereEffect<unknown, unknown, TEvent> {
    return waitEvent(this, match);
  }

  #deleteWaiter(waiter: Waiter<TEvent>): void {
    this.#waiters.delete(waiter);

    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener("abort", waiter.abort as EventListener);
    }
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

  #abortError(): DOMException {
    return new DOMException("Insere mailbox wait was cancelled.", "AbortError");
  }
}

export function createInsereMailbox<TEvent = unknown>(
  options: InsereMailboxOptions = {}
): InsereMailbox<TEvent> {
  return new InsereMailbox(options);
}

export function waitEvent<TEvent>(
  mailbox: InsereMailbox<TEvent>,
  match: InsereEventMatcher<TEvent> = () => true
): InsereEffect<unknown, unknown, TEvent> {
  return asyncEffect((context) => mailbox.wait(match, { signal: context.signal }));
}
