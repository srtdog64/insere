import {
  InsereApi,
  createInsereApi,
  type InsereApiOptions
} from "./api.js";
import {
  InsereMailbox,
  createInsereMailbox,
  waitEvent,
  type InsereEventMatcher,
  type InsereMailboxOptions
} from "./mailbox.js";
import {
  InsereEventBus,
  createInsereEventBus,
  waitBusEvent,
  type InsereEventListener,
  type InsereEventBusOptions,
  type InsereEventBusSubscribeOptions
} from "./event-bus.js";
import type { InsereEffect, InsereResult } from "./effect.js";


export interface InsereHostAdapterOptions<
  TState = unknown,
  TDispatchEvent = unknown
> extends InsereApiOptions<TState, TDispatchEvent> {
  readonly mailbox?: InsereMailboxOptions;
  readonly eventBus?: InsereEventBusOptions;
}

export class InsereHostAdapter<
  TState = unknown,
  TDispatchEvent = unknown,
  TInboundEvent = unknown
> {
  readonly api: InsereApi<TState, TDispatchEvent>;
  readonly mailbox: InsereMailbox<TInboundEvent>;
  readonly eventBus: InsereEventBus<string, TInboundEvent>;

  constructor(
    options: InsereHostAdapterOptions<TState, TDispatchEvent> = {}
  ) {
    this.api = createInsereApi(options);
    this.mailbox = createInsereMailbox<TInboundEvent>(options.mailbox);
    this.eventBus = createInsereEventBus<string, TInboundEvent>(options.eventBus);
  }

  get frame(): number {
    return this.api.frame;
  }

  get now(): number {
    return this.api.now;
  }

  get delta(): number {
    return this.api.delta;
  }

  tick(now: number): InsereResult<void> {
    return this.api.tick(now);
  }

  runIdle(): InsereResult<void> {
    return this.api.runIdle();
  }

  emit(event: TInboundEvent): number {
    return this.mailbox.emit(event);
  }

  waitEvent(
    match?: InsereEventMatcher<TInboundEvent>
  ): InsereEffect<unknown, unknown, TInboundEvent> {
    return waitEvent(this.mailbox, match);
  }

  emitTo(key: string, event: TInboundEvent): number {
    return this.eventBus.emit(key, event);
  }

  publishTo(key: string, event: TInboundEvent): number {
    return this.eventBus.publish(key, event);
  }

  waitBusEvent(key: string): InsereEffect<unknown, unknown, TInboundEvent> {
    return waitBusEvent(this.eventBus, key);
  }

  subscribeTo(
    key: string,
    listener: InsereEventListener<TInboundEvent>,
    options?: InsereEventBusSubscribeOptions
  ): () => void {
    return this.eventBus.subscribe(key, listener, options);
  }
}

export function createInsereHostAdapter<
  TState = unknown,
  TDispatchEvent = unknown,
  TInboundEvent = unknown
>(
  options: InsereHostAdapterOptions<TState, TDispatchEvent> = {}
): InsereHostAdapter<TState, TDispatchEvent, TInboundEvent> {
  return new InsereHostAdapter(options);
}
