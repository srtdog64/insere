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
  type InsereEventBusOptions
} from "./event-bus.js";
import type { InsereEffect } from "./effect.js";

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

  tick(now: number): void {
    this.api.tick(now);
  }

  runIdle(): void {
    this.api.runIdle();
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

  waitBusEvent(key: string): InsereEffect<unknown, unknown, TInboundEvent> {
    return waitBusEvent(this.eventBus, key);
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
