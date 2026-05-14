import { asyncEffect, type InsereEffect } from "./effect.js";
import type {
  InsereMailboxBufferPolicy,
  InsereMailboxOverflowPolicy
} from "./mailbox.js";

export interface InsereEventBusOptions {
  readonly buffer?: InsereMailboxBufferPolicy;
  readonly capacity?: number;
  readonly overflow?: InsereMailboxOverflowPolicy;
}

export interface InsereEventBusWaitOptions {
  readonly signal?: AbortSignal;
}

interface Waiter<TEvent> {
  readonly resolve: (event: TEvent) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
}

export class InsereEventBus<TKey = string, TEvent = unknown> {
  readonly #buffer: InsereMailboxBufferPolicy;
  readonly #capacity: number;
  readonly #overflow: InsereMailboxOverflowPolicy;
  readonly #events = new Map<TKey, TEvent[]>();
  readonly #waiters = new Map<TKey, Waiter<TEvent> | Set<Waiter<TEvent>>>();
  #size = 0;
  #waiterCount = 0;

  constructor(options: InsereEventBusOptions = {}) {
    this.#buffer = options.buffer ?? "drop";
    this.#capacity = options.capacity ?? 128;
    this.#overflow = options.overflow ?? "drop-oldest";

    if (!Number.isInteger(this.#capacity) || this.#capacity < 1) {
      throw new RangeError("Insere event bus capacity must be a positive integer.");
    }
  }

  get size(): number {
    return this.#size;
  }

  get waiters(): number {
    return this.#waiterCount;
  }

  clear(key?: TKey): void {
    if (key === undefined) {
      this.#events.clear();
      this.#size = 0;
      return;
    }

    const events = this.#events.get(key);
    if (!events) {
      return;
    }

    this.#size -= events.length;
    this.#events.delete(key);
  }

  emit(key: TKey, event: TEvent): number {
    const waiters = this.#waiters.get(key);

    if (!waiters) {
      this.#bufferEvent(key, event);
      return 0;
    }

    if (!isWaiterSet(waiters)) {
      this.#deleteWaiter(key, waiters);
      waiters.resolve(event);
      return 1;
    }

    let delivered = 0;

    for (const waiter of waiters) {
      this.#deleteWaiter(key, waiter);
      waiter.resolve(event);
      delivered += 1;
    }

    return delivered;
  }

  wait(key: TKey, options: InsereEventBusWaitOptions = {}): Promise<TEvent> {
    const events = this.#events.get(key);
    if (events && events.length > 0) {
      const event = events.shift() as TEvent;
      this.#size -= 1;

      if (events.length === 0) {
        this.#events.delete(key);
      }

      return Promise.resolve(event);
    }

    const { signal } = options;
    if (signal?.aborted) {
      return Promise.reject(this.#abortError());
    }

    return new Promise<TEvent>((resolve, reject) => {
      let waiter: Waiter<TEvent>;
      const abort = signal
        ? () => {
            this.#deleteWaiter(key, waiter);
            reject(this.#abortError());
          }
        : undefined;

      waiter = {
        resolve,
        reject,
        signal,
        abort
      };

      signal?.addEventListener("abort", abort as EventListener, { once: true });
      const waiters = this.#waiters.get(key);

      if (!waiters) {
        this.#waiters.set(key, waiter);
      } else if (isWaiterSet(waiters)) {
        waiters.add(waiter);
      } else {
        this.#waiters.set(key, new Set([waiters, waiter]));
      }

      this.#waiterCount += 1;
    });
  }

  waitEffect(key: TKey): InsereEffect<unknown, unknown, TEvent> {
    return waitBusEvent(this, key);
  }

  #deleteWaiter(key: TKey, waiter: Waiter<TEvent>): void {
    const waiters = this.#waiters.get(key);

    if (!waiters) {
      return;
    }

    if (!isWaiterSet(waiters)) {
      if (waiters !== waiter) {
        return;
      }

      this.#waiters.delete(key);
      this.#waiterCount -= 1;
      this.#removeAbortListener(waiter);
      return;
    }

    if (!waiters.delete(waiter)) {
      return;
    }

    this.#waiterCount -= 1;

    if (waiters.size === 0) {
      this.#waiters.delete(key);
    }

    this.#removeAbortListener(waiter);
  }

  #removeAbortListener(waiter: Waiter<TEvent>): void {
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener("abort", waiter.abort as EventListener);
    }
  }

  #bufferEvent(key: TKey, event: TEvent): void {
    switch (this.#buffer) {
      case "drop":
        return;
      case "latest":
        this.#setEvents(key, [event]);
        return;
      case "queue":
        this.#pushEvent(key, event);
        return;
      case "bounded":
        if (this.#size < this.#capacity) {
          this.#pushEvent(key, event);
          return;
        }

        switch (this.#overflow) {
          case "drop-oldest":
            this.#dropOldest();
            this.#pushEvent(key, event);
            return;
          case "drop-newest":
            return;
          case "throw":
            throw new Error("Insere event bus capacity exceeded.");
        }
    }
  }

  #pushEvent(key: TKey, event: TEvent): void {
    let events = this.#events.get(key);

    if (!events) {
      events = [];
      this.#events.set(key, events);
    }

    events.push(event);
    this.#size += 1;
  }

  #setEvents(key: TKey, events: TEvent[]): void {
    const previous = this.#events.get(key);

    if (previous) {
      this.#size -= previous.length;
    }

    this.#events.set(key, events);
    this.#size += events.length;
  }

  #dropOldest(): void {
    const first = this.#events.entries().next();

    if (first.done) {
      return;
    }

    const [key, events] = first.value;
    events.shift();
    this.#size -= 1;

    if (events.length === 0) {
      this.#events.delete(key);
    }
  }

  #abortError(): DOMException {
    return new DOMException("Insere event bus wait was cancelled.", "AbortError");
  }
}

function isWaiterSet<TEvent>(
  waiters: Waiter<TEvent> | Set<Waiter<TEvent>>
): waiters is Set<Waiter<TEvent>> {
  return waiters instanceof Set;
}

export function createInsereEventBus<TKey = string, TEvent = unknown>(
  options: InsereEventBusOptions = {}
): InsereEventBus<TKey, TEvent> {
  return new InsereEventBus(options);
}

export function waitBusEvent<TKey, TEvent>(
  bus: InsereEventBus<TKey, TEvent>,
  key: TKey
): InsereEffect<unknown, unknown, TEvent> {
  return asyncEffect((context) => bus.wait(key, { signal: context.signal }));
}
