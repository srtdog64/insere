import { describe, expect, it } from "vitest";

import {
  createInsereHostAdapter,
  dispatch,
  waitEvent
} from "../src/index.js";

describe("Geukbit scale surfaces", () => {
  it("cancels per-entity lifecycle scopes by key prefix", () => {
    const entityCount = 300;
    const scriptsPerEntity = 3;
    const cleaned: string[] = [];
    const host = createInsereHostAdapter();

    for (let entity = 0; entity < entityCount; entity += 1) {
      for (let script = 0; script < scriptsPerEntity; script += 1) {
        const key = `entity:${entity}:script:${script}`;
        host.api.applyDirect(key, (ctx) => {
          ctx.onCancel(() => cleaned.push(ctx.key));
          ctx.waitFrame();
        });
      }
    }

    expect(host.api.size).toBe(entityCount * scriptsPerEntity);
    expect(host.api.cancelGroup("entity:42:")).toBe(scriptsPerEntity);
    expect(cleaned).toHaveLength(scriptsPerEntity);
    expect(host.api.keys().some((key) => key.startsWith("entity:42:"))).toBe(false);

    expect(host.api.cancelGroup("entity:")).toBe((entityCount - 1) * scriptsPerEntity);
    expect(host.api.size).toBe(0);
  });

  it("routes targeted script event bus waits through keyed event channels", async () => {
    const entityCount = 256;
    const events: string[] = [];
    const host = createInsereHostAdapter<
      unknown,
      string,
      { readonly type: "script"; readonly entity: number }
    >({
      dispatch: (event) => events.push(event),
      eventBus: { buffer: "bounded", capacity: entityCount * 2 }
    });

    for (let entity = 0; entity < entityCount; entity += 1) {
      host.api.applyEffect(`entity:${entity}:script:event`, function* (ctx) {
        const event = yield* host.waitBusEvent(`entity:${entity}`)(ctx);
        yield* dispatch(`event:${event.entity}`)(ctx);
      });
    }

    expect(host.eventBus.waiters).toBe(entityCount);

    for (let entity = 0; entity < entityCount; entity += 1) {
      host.emitTo(`entity:${entity}`, { type: "script", entity });
    }

    await Promise.resolve();
    host.tick(1);

    expect(events).toHaveLength(entityCount);
    expect(events[0]).toBe("event:0");
    expect(events[entityCount - 1]).toBe(`event:${entityCount - 1}`);
    expect(host.api.size).toBe(0);
    expect(host.eventBus.waiters).toBe(0);
  });

  it("routes hot script event subscriptions without Promise waits", () => {
    const entityCount = 1_000;
    let delivered = 0;
    const host = createInsereHostAdapter<
      unknown,
      never,
      { readonly type: "script"; readonly entity: number }
    >();

    for (let entity = 0; entity < entityCount; entity += 1) {
      host.api.applyDirect(`entity:${entity}:script:subscribe`, (ctx) => {
        const unsubscribe = host.eventBus.subscribe(
          `entity:${entity}`,
          (event) => {
            delivered += event.entity;
          },
          { signal: ctx.signal }
        );
        ctx.onCancel(unsubscribe);
        ctx.waitFrame();
      });
    }

    expect(host.eventBus.listeners).toBe(entityCount);

    for (let entity = 0; entity < entityCount; entity += 1) {
      expect(host.emitTo(`entity:${entity}`, { type: "script", entity })).toBe(1);
    }

    expect(delivered).toBe((entityCount * (entityCount - 1)) / 2);
    expect(host.api.cancelGroup("entity:")).toBe(entityCount);
    expect(host.eventBus.listeners).toBe(0);
  });

  it("runs gameplay frame continuations for many active entities", () => {
    const entityCount = 5_000;
    const frames = 3;
    let steps = 0;
    const host = createInsereHostAdapter();

    for (let entity = 0; entity < entityCount; entity += 1) {
      host.api.waitFrame(`gameplay:entity:${entity}`, (ctx) => {
        steps += 1;

        if (ctx.frame < frames) {
          ctx.waitFrame();
        }
      });
    }

    for (let frame = 1; frame <= frames; frame += 1) {
      host.tick(frame);
    }

    expect(steps).toBe(entityCount * frames);
    expect(host.api.size).toBe(0);
  });

  it("keeps physics and animation hot loops inside one host task", () => {
    const entityCount = 10_000;
    const frames = 5;
    const position = new Float64Array(entityCount);
    const velocity = new Float64Array(entityCount);
    const host = createInsereHostAdapter();

    velocity.fill(2);

    host.api.waitFrame("physics:step", (ctx) => {
      for (let entity = 0; entity < entityCount; entity += 1) {
        position[entity] += velocity[entity] * 0.5;
      }

      if (ctx.frame < frames) {
        ctx.waitFrame();
      }
    });

    for (let frame = 1; frame <= frames; frame += 1) {
      host.tick(frame);
      expect(host.api.size).toBe(frame < frames ? 1 : 0);
    }

    expect(position[0]).toBe(5);
    expect(position[entityCount - 1]).toBe(5);
  });

  it("keeps runtime projection rebuilds latest-only under restart storms", () => {
    const restarts = 50_000;
    const events: number[] = [];
    const host = createInsereHostAdapter<unknown, number>({
      dispatch: (event) => events.push(event)
    });

    for (let version = 0; version < restarts; version += 1) {
      host.api.restartDirect("projection:scene:main", (ctx) => {
        if (ctx.frame === 0) {
          ctx.waitFrame();
          return;
        }

        ctx.dispatch(version);
      });
    }

    host.tick(1);

    expect(events).toEqual([restarts - 1]);
    expect(host.api.size).toBe(0);
  });
});
