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
  readonly #uniqueWaiters = new Map<TKey, ResolveFn<TEvent> | Waiter<TEvent>>();
  readonly #listeners = new Map<TKey, ListenerSlot<TEvent>>();
  #size = 0;
  #waiterCount = 0;
  #uniqueWaiterCount = 0;
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
    return this.#waiterCount + this.#uniqueWaiterCount;
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
    if (this.#listenerCount === 0) {
      if (this.#waiterCount === 0) {
        this.#bufferEvent(key, event);
        return 0;
      }

      const waitersMap = this.#waiters;
      const waiters = waitersMap.get(key);

      if (!waiters) {
        this.#bufferEvent(key, event);
        return 0;
      }

      waitersMap.delete(key);

      if (typeof waiters === "function") {
        this.#waiterCount -= 1;
        waiters(event);
        return 1;
      }

      if (!(waiters instanceof Set)) {
        this.#waiterCount -= 1;
        this.#resolveWaiter(waiters, event);
        return 1;
      }

      this.#waiterCount -= waiters.size;
      let delivered = 0;

      for (const waiter of waiters) {
        if (typeof waiter === "function") {
          waiter(event);
        } else {
          this.#resolveWaiter(waiter, event);
        }
        delivered += 1;
      }

      return delivered;
    }

    let delivered = 0;

    delivered = publishListenerSlot(this.#listeners.get(key), event);

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
      this.#resolveWaiter(waiters, event);
      return delivered + 1;
    }

    this.#waiterCount -= waiters.size;

    for (const waiter of waiters) {
      if (typeof waiter === "function") {
        waiter(event);
      } else {
        this.#resolveWaiter(waiter, event);
      }
      delivered += 1;
    }

    return delivered;
  }

  emitUnique(key: TKey, event: TEvent): number {
    if (this.#uniqueWaiterCount === 0) {
      return 0;
    }

    const waiters = this.#uniqueWaiters;
    const waiter = waiters.get(key);
    if (waiter === undefined) {
      return 0;
    }

    waiters.delete(key);
    this.#uniqueWaiterCount -= 1;

    if (typeof waiter === "function") {
      waiter(event);
    } else {
      this.#resolveWaiter(waiter, event);
    }

    return 1;
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
    options?: InsereEventBusSubscribeOptions
  ): () => void {
    const signal = options?.signal;

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

  wait(key: TKey, options?: InsereEventBusWaitOptions): Promise<TEvent> {
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

    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(this.#abortError());
    }

    if (signal === undefined) {
      return new Promise<TEvent>((resolve) => {
        const waiters = this.#waiters.get(key);

        if (!waiters) {
          this.#waiters.set(key, resolve);
        } else if (isWaiterSet(waiters)) {
          waiters.add(resolve);
        } else {
          this.#waiters.set(key, new Set([waiters, resolve]));
        }

        this.#waiterCount += 1;
      });
    }

    return new Promise<TEvent>((resolve, reject) => {
      const slot: Waiter<TEvent> = {
        resolve,
        reject,
        signal,
        abort: undefined
      };
      const abort = () => {
        this.#deleteWaiter(key, slot);
        reject(this.#abortError());
      };
      slot.abort = abort;
      signal.addEventListener("abort", abort as EventListener, {
        once: true
      });

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

  waitUnique(key: TKey, options?: InsereEventBusWaitOptions): Promise<TEvent> {
    if (this.#uniqueWaiters.has(key)) {
      return Promise.reject(new Error("Insere event bus unique waiter already exists."));
    }

    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(this.#abortError());
    }

    if (signal === undefined) {
      return new Promise<TEvent>((resolve) => {
        this.#uniqueWaiters.set(key, resolve);
        this.#uniqueWaiterCount += 1;
      });
    }

    return new Promise<TEvent>((resolve, reject) => {
      const waiter: Waiter<TEvent> = {
        resolve,
        reject,
        signal,
        abort: undefined
      };
      const abort = () => {
        this.#deleteUniqueWaiter(key, waiter);
        reject(this.#abortError());
      };
      waiter.abort = abort;
      signal.addEventListener("abort", abort as EventListener, {
        once: true
      });

      this.#uniqueWaiters.set(key, waiter);
      this.#uniqueWaiterCount += 1;
    });
  }

  waitEffect<TState = unknown, TDispatchEvent = unknown>(
    key: TKey
  ): InsereEffect<TState, TDispatchEvent, TEvent> {
    return waitBusEvent(this, key);
  }

  waitUniqueEffect<TState = unknown, TDispatchEvent = unknown>(
    key: TKey
  ): InsereEffect<TState, TDispatchEvent, TEvent> {
    return waitUniqueBusEvent(this, key);
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

  #deleteUniqueWaiter(key: TKey, waiter: Waiter<TEvent>): void {
    if (this.#uniqueWaiters.get(key) !== waiter) {
      return;
    }

    this.#uniqueWaiters.delete(key);
    this.#uniqueWaiterCount -= 1;
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

  #resolveWaiter(waiter: Waiter<TEvent>, event: TEvent): void {
    this.#removeAbortListener(waiter);
    waiter.resolve(event);
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

function publishListenerSlot<TEvent>(
  listeners: ListenerSlot<TEvent> | undefined,
  event: TEvent
): number {
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

export function waitUniqueBusEvent<
  TKey,
  TEvent,
  TState = unknown,
  TDispatchEvent = unknown
>(
  bus: InsereEventBus<TKey, TEvent>,
  key: TKey
): InsereEffect<TState, TDispatchEvent, TEvent> {
  return asyncEffect((context) => bus.waitUnique(key, { signal: context.signal }));
}
