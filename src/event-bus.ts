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
  resolve: (event: TEvent) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  abort: (() => void) | undefined;
}

interface Listener<TEvent> {
  readonly run: InsereEventListener<TEvent>;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
}

type ListenerSlot<TEvent> =
  | InsereEventListener<TEvent>
  | Listener<TEvent>
  | Set<InsereEventListener<TEvent> | Listener<TEvent>>;

type ResolveFn<TEvent> = (event: TEvent) => void;

type WaiterSlot<TEvent> =
  | ResolveFn<TEvent>
  | Waiter<TEvent>
  | Set<ResolveFn<TEvent> | Waiter<TEvent>>;

export class InsereEventBus<TKey = string, TEvent = unknown> {
  readonly #buffer: InsereMailboxBufferPolicy;
  readonly #capacity: number;
  readonly #overflow: InsereMailboxOverflowPolicy;
  readonly #events = new Map<TKey, TEvent[]>();
  readonly #waiters = new Map<TKey, WaiterSlot<TEvent>>();
  readonly #listeners = new Map<TKey, ListenerSlot<TEvent>>();
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
    let delivered = 0;

    if (this.#listenerCount !== 0) {
      const listeners = this.#listeners.get(key);

      if (typeof listeners === "function") {
        listeners(event);
        delivered = 1;
      } else if (listeners !== undefined) {
        if (!isListenerSet(listeners)) {
          listeners.run(event);
          delivered = 1;
        } else {
          for (const listener of listeners) {
            if (typeof listener === "function") {
              listener(event);
            } else {
              listener.run(event);
            }
            delivered += 1;
          }
        }
      }
    }

    if (this.#waiterCount === 0) {
      if (delivered === 0) {
        this.#bufferEvent(key, event);
      }

      return delivered;
    }

    const waitersMap = this.#waiters;
    const waiters = waitersMap.get(key);

    if (!waiters) {
      if (delivered === 0) {
        this.#bufferEvent(key, event);
      }

      return delivered;
    }

    waitersMap.delete(key);

    if (typeof waiters === "function") {
      this.#waiterCount -= 1;
      waiters(event);
      return delivered + 1;
    }

    if (!(waiters instanceof Set)) {
      this.#waiterCount -= 1;
      const signal = waiters.signal;
      if (signal !== undefined) {
        const abort = waiters.abort;
        if (abort !== undefined) {
          signal.removeEventListener("abort", abort as EventListener);
        }
      }
      waiters.resolve(event);
      return delivered + 1;
    }

    this.#waiterCount -= waiters.size;

    for (const waiter of waiters) {
      if (typeof waiter === "function") {
        waiter(event);
      } else {
        const signal = waiter.signal;
        if (signal !== undefined) {
          const abort = waiter.abort;
          if (abort !== undefined) {
            signal.removeEventListener("abort", abort as EventListener);
          }
        }
        waiter.resolve(event);
      }
      delivered += 1;
    }

    return delivered;
  }

  publish(key: TKey, event: TEvent): number {
    const listeners = this.#listeners.get(key);

    if (typeof listeners === "function") {
      listeners(event);
      return 1;
    }

    if (listeners === undefined) {
      return 0;
    }

    if (!isListenerSet(listeners)) {
      listeners.run(event);
      return 1;
    }

    let delivered = 0;

    for (const listener of listeners) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.run(event);
      }
      delivered += 1;
    }

    return delivered;
  }

  notify(key: TKey, event: TEvent): void {
    const listeners = this.#listeners.get(key);

    if (typeof listeners === "function") {
      listeners(event);
      return;
    }

    if (listeners === undefined) {
      return;
    }

    if (!isListenerSet(listeners)) {
      listeners.run(event);
      return;
    }

    for (const listener of listeners) {
      if (typeof listener === "function") {
        listener(event);
      } else {
        listener.run(event);
      }
    }
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

    let listener: InsereEventListener<TEvent> | Listener<TEvent>;
    const unsubscribe = () => this.#deleteListener(key, listener);

    if (signal === undefined) {
      listener = run;
    } else {
      const abort = unsubscribe;
      listener = {
        run,
        signal,
        abort
      };
      signal.addEventListener("abort", abort as EventListener, { once: true });
    }

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
    if (this.#size > 0) {
      const events = this.#events.get(key);
      if (events && events.length > 0) {
        const event = events.shift() as TEvent;
        this.#size -= 1;

        if (events.length === 0) {
          this.#events.delete(key);
        }

        return Promise.resolve(event);
      }
    }

    const { signal } = options;
    if (signal?.aborted) {
      return Promise.reject(this.#abortError());
    }

    return new Promise<TEvent>((resolve, reject) => {
      const slot: ResolveFn<TEvent> | Waiter<TEvent> =
        signal === undefined
          ? resolve
          : (() => {
              const waiter: Waiter<TEvent> = {
                resolve,
                reject,
                signal,
                abort: undefined
              };
              const abort = () => {
                this.#deleteWaiter(key, waiter);
                reject(this.#abortError());
              };
              waiter.abort = abort;
              signal.addEventListener("abort", abort as EventListener, {
                once: true
              });
              return waiter;
            })();

      const waiters = this.#waiters.get(key);

      if (!waiters) {
        this.#waiters.set(key, slot);
      } else if (isWaiterSet(waiters)) {
        waiters.add(slot);
      } else {
        this.#waiters.set(key, new Set([waiters, slot]));
      }

      this.#waiterCount += 1;
    });
  }

  waitEffect<TState = unknown, TDispatchEvent = unknown>(
    key: TKey
  ): InsereEffect<TState, TDispatchEvent, TEvent> {
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
    } else if (waiters.size === 1) {
      const [solo] = waiters;
      this.#waiters.set(key, solo!);
    }

    this.#removeAbortListener(waiter);
  }

  #deleteListener(
    key: TKey,
    listener: InsereEventListener<TEvent> | Listener<TEvent>
  ): void {
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

  #removeListenerAbortListener(
    listener: InsereEventListener<TEvent> | Listener<TEvent>
  ): void {
    if (typeof listener === "function") {
      return;
    }

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
  waiters: WaiterSlot<TEvent>
): waiters is Set<ResolveFn<TEvent> | Waiter<TEvent>> {
  return waiters instanceof Set;
}

function isListenerSet<TEvent>(
  listeners: ListenerSlot<TEvent>
): listeners is Set<InsereEventListener<TEvent> | Listener<TEvent>> {
  return listeners instanceof Set;
}

export function createInsereEventBus<TKey = string, TEvent = unknown>(
  options: InsereEventBusOptions = {}
): InsereEventBus<TKey, TEvent> {
  return new InsereEventBus(options);
}

export function waitBusEvent<
  TKey,
  TEvent,
  TState = unknown,
  TDispatchEvent = unknown
>(
  bus: InsereEventBus<TKey, TEvent>,
  key: TKey
): InsereEffect<TState, TDispatchEvent, TEvent> {
  return asyncEffect((context) => bus.wait(key, { signal: context.signal }));
}
