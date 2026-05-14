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

export interface InsereEventBusSubscribeOptions {
  readonly signal?: AbortSignal;
}

export type InsereEventListener<TEvent> = (event: TEvent) => void;

interface Waiter<TEvent> {
  readonly resolve: (event: TEvent) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
}

interface Listener<TEvent> {
  readonly run: InsereEventListener<TEvent>;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
}

export class InsereEventBus<TKey = string, TEvent = unknown> {
  readonly #buffer: InsereMailboxBufferPolicy;
  readonly #capacity: number;
  readonly #overflow: InsereMailboxOverflowPolicy;
  readonly #events = new Map<TKey, TEvent[]>();
  readonly #waiters = new Map<TKey, Waiter<TEvent> | Set<Waiter<TEvent>>>();
  readonly #listeners = new Map<TKey, Listener<TEvent> | Set<Listener<TEvent>>>();
  #size = 0;
  #waiterCount = 0;
  #listenerCount = 0;

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

  get listeners(): number {
    return this.#listenerCount;
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
    let delivered = this.#emitListeners(key, event);
    const waiters = this.#waiters.get(key);

    if (!waiters) {
      if (delivered === 0) {
        this.#bufferEvent(key, event);
      }

      return delivered;
    }

    if (!isWaiterSet(waiters)) {
      this.#deleteWaiter(key, waiters);
      waiters.resolve(event);
      return delivered + 1;
    }

    for (const waiter of waiters) {
      this.#deleteWaiter(key, waiter);
      waiter.resolve(event);
      delivered += 1;
    }

    return delivered;
  }

  subscribe(
    key: TKey,
    run: InsereEventListener<TEvent>,
    options: InsereEventBusSubscribeOptions = {}
  ): () => void {
    const { signal } = options;

    if (signal?.aborted) {
      return () => undefined;
    }

    let listener: Listener<TEvent>;
    const unsubscribe = () => this.#deleteListener(key, listener);
    const abort = signal ? unsubscribe : undefined;

    listener = {
      run,
      signal,
      abort
    };

    signal?.addEventListener("abort", abort as EventListener, { once: true });
    const listeners = this.#listeners.get(key);

    if (!listeners) {
      this.#listeners.set(key, listener);
    } else if (isListenerSet(listeners)) {
      listeners.add(listener);
    } else {
      this.#listeners.set(key, new Set([listeners, listener]));
    }

    this.#listenerCount += 1;
    return unsubscribe;
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

  #emitListeners(key: TKey, event: TEvent): number {
    const listeners = this.#listeners.get(key);

    if (!listeners) {
      return 0;
    }

    if (!isListenerSet(listeners)) {
      listeners.run(event);
      return 1;
    }

    let delivered = 0;

    for (const listener of listeners) {
      listener.run(event);
      delivered += 1;
    }

    return delivered;
  }

  #deleteListener(key: TKey, listener: Listener<TEvent>): void {
    const listeners = this.#listeners.get(key);

    if (!listeners) {
      return;
    }

    if (!isListenerSet(listeners)) {
      if (listeners !== listener) {
        return;
      }

      this.#listeners.delete(key);
      this.#listenerCount -= 1;
      this.#removeListenerAbortListener(listener);
      return;
    }

    if (!listeners.delete(listener)) {
      return;
    }

    this.#listenerCount -= 1;

    if (listeners.size === 0) {
      this.#listeners.delete(key);
    }

    this.#removeListenerAbortListener(listener);
  }

  #removeListenerAbortListener(listener: Listener<TEvent>): void {
    if (listener.signal && listener.abort) {
      listener.signal.removeEventListener("abort", listener.abort as EventListener);
    }
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

function isListenerSet<TEvent>(
  listeners: Listener<TEvent> | Set<Listener<TEvent>>
): listeners is Set<Listener<TEvent>> {
  return listeners instanceof Set;
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
