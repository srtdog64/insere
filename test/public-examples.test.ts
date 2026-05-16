import { describe, expect, it } from "vitest";

import {
  Insere,
  createInsereHostAdapter,
  delay,
  dispatch,
  frame,
  type InsereFailureResult
} from "../src/index.js";
import { createInsereApi } from "../src/api.js";

describe("public examples", () => {
  it("runs the root generator example", () => {
    const events: Array<{ readonly type: string }> = [];
    const insere = new Insere<unknown, { readonly type: string }>({
      dispatch: (event) => events.push(event)
    });

    insere.restart("drag", function* (ctx) {
      yield frame();
      ctx.dispatch({ type: "dragFrame" });
    });

    insere.restart("projection", function* (ctx) {
      yield delay(16);
      ctx.throwIfCancelled();
      ctx.dispatch({ type: "projectionReady" });
    });

    insere.tick(0);
    insere.tick(16);

    expect(events).toEqual([
      { type: "dragFrame" },
      { type: "projectionReady" }
    ]);
  });

  it("runs the API facade example", () => {
    const api = createInsereApi();
    const editor = api.scope("editor");
    let projectionRuns = 0;
    let dragRuns = 0;
    let autosaveRuns = 0;

    api.applyDirectResult("projection:scene", (ctx) => {
      projectionRuns += 1;

      if (ctx.frame === 0) {
        ctx.waitFrame();
      }
    }, "restart");

    api.applyDirectResult("drag:preview", () => {
      dragRuns += 1;
    }, "restart", "frame");

    editor.applyDirectResult("autosave", () => {
      autosaveRuns += 1;
    }, "skip", "frame");
    api.frameLoopResult("gameplay:systems", (ctx) => {
      if (ctx.frame > 1) {
        return false;
      }

      return true;
    });

    api.tick(0);
    api.tick(16);

    expect(projectionRuns).toBe(2);
    expect(dragRuns).toBe(1);
    expect(autosaveRuns).toBe(1);
    expect(api.has("gameplay:systems")).toBe(false);
  });

  it("runs the host adapter example with typed inbound events", async () => {
    type HostEvent =
      | { readonly type: "pointerup"; readonly x: number; readonly y: number }
      | { readonly type: "damage"; readonly amount: number };

    type AppEvent =
      | { readonly type: "commitPointer"; readonly event: HostEvent }
      | { readonly type: "scriptEvent"; readonly event: HostEvent }
      | { readonly type: "taskFailed"; readonly failure: unknown };

    const events: AppEvent[] = [];
    const seen: HostEvent[] = [];
    const failures: InsereFailureResult[] = [];
    const host = createInsereHostAdapter<unknown, AppEvent, HostEvent>({
      dispatch: (event) => events.push(event),
      mailbox: { buffer: "bounded", capacity: 256 },
      supervision: {
        policy: "dispatchAndStop",
        toEvent: (failure) => ({ type: "taskFailed", failure }),
        onResult: (result) => failures.push(result)
      }
    });

    host.api.applyEffectResult("input:pointerup", function* (ctx) {
      const event = yield* host.waitEvent(
        (item) => item.type === "pointerup"
      )(ctx);
      yield* dispatch<AppEvent>({ type: "commitPointer", event })(ctx);
    });

    host.api.applyDirectResult("entity:42:events", (ctx) => {
      const unsubscribe = host.subscribeTo(
        "entity:42",
        (event) => seen.push(event),
        { signal: ctx.signal }
      );

      ctx.onCancel(unsubscribe);
      ctx.waitFrame();
    });

    host.api.applyEffectResult("entity:42:next-hit", function* (ctx) {
      const event = yield* host.waitUniqueBusEvent("entity:42")(ctx);
      yield* dispatch<AppEvent>({ type: "scriptEvent", event })(ctx);
    });

    host.emit({ type: "pointerup", x: 12, y: 20 });
    host.notifyTo("entity:42", { type: "damage", amount: 3 });
    host.emitUniqueTo("entity:42", { type: "damage", amount: 10 });
    await Promise.resolve();
    host.tick(16);

    expect(events).toEqual([
      {
        type: "commitPointer",
        event: { type: "pointerup", x: 12, y: 20 }
      },
      {
        type: "scriptEvent",
        event: { type: "damage", amount: 10 }
      }
    ]);
    expect(seen).toEqual([{ type: "damage", amount: 3 }]);
    expect(failures).toEqual([]);
  });
});
