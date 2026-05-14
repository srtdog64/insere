import { describe, expect, it } from "vitest";

import {
  createBufferedInsereLogger,
  createInsereApi,
  dispatch,
  ok,
  sequence,
  sleep,
  waitFrame
} from "../src/index.js";

describe("InsereApi", () => {
  it("runs direct and effect tasks from one host clock", () => {
    const events: string[] = [];
    const api = createInsereApi<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    api.waitFrame("direct:preview", (ctx) => ctx.dispatch("direct"));
    api.applyEffect("effect:projection", sequence([
      waitFrame(),
      dispatch("effect")
    ]));

    api.tick(16);

    expect(events).toEqual(["direct", "effect"]);
    expect(api.size).toBe(0);
  });

  it("returns Result reports for scoped direct and effect policy", () => {
    const api = createInsereApi();
    const editor = api.scope("editor");

    expect(editor.applyDirectResult(
      "preview",
      (ctx) => ctx.complete(),
      "skip",
      "frame"
    )).toEqual(ok({
      key: "editor:preview",
      policy: "skip",
      applied: true,
      status: "started"
    }));
    expect(editor.applyDirectResult(
      "preview",
      (ctx) => ctx.complete(),
      "skip",
      "frame"
    )).toEqual(ok({
      key: "editor:preview",
      policy: "skip",
      applied: false,
      status: "skipped"
    }));

    expect(editor.applyEffectResult("autosave", sleep(10), "skip")).toEqual(
      ok({
        key: "editor:autosave",
        policy: "skip",
        applied: true,
        status: "started"
      })
    );
    expect(editor.applyEffectResult("autosave", sleep(1), "skip")).toEqual(
      ok({
        key: "editor:autosave",
        policy: "skip",
        applied: false,
        status: "skipped"
      })
    );
  });

  it("scopes keys, snapshots, and cancellation across direct and effect runtimes", () => {
    const api = createInsereApi();
    const projection = api.scope("editor", "projection");

    projection.waitFrame("preview", (ctx) => ctx.complete());
    projection.applyEffect("primary", sleep(10));
    api.waitFrame("outside", (ctx) => ctx.complete());

    expect(projection.keys()).toEqual([
      "editor:projection:preview",
      "editor:projection:primary"
    ]);
    expect(projection.snapshot()).toMatchObject({
      size: 2,
      direct: {
        size: 1,
        entries: [{ key: "editor:projection:preview", wait: "frame" }]
      },
      effect: {
        size: 1,
        entries: [{ key: "editor:projection:primary", wait: "delay" }]
      }
    });
    expect(projection.cancelScope()).toBe(2);
    expect(api.keys()).toEqual(["outside"]);
  });

  it("cancels the same key across direct and effect runtimes", () => {
    const api = createInsereApi();

    api.waitFrame("shared", (ctx) => ctx.complete());
    api.applyEffect("shared", sleep(10));

    expect(api.cancel("shared")).toBe(true);
    expect(api.has("shared")).toBe(false);
  });

  it("applies facade policy across the shared direct/effect key space", () => {
    const api = createInsereApi();

    expect(api.applyEffectResult("refresh", sleep(10), "restart")).toEqual(ok({
      key: "refresh",
      policy: "restart",
      applied: true,
      status: "started"
    }));
    expect(api.applyDirectResult(
      "refresh",
      (ctx) => ctx.complete(),
      "restart",
      "frame"
    )).toEqual(ok({
      key: "refresh",
      policy: "restart",
      applied: true,
      status: "restarted"
    }));
    expect(api.effect.has("refresh")).toBe(false);
    expect(api.direct.has("refresh")).toBe(true);

    api.applyEffect("shared", sleep(10));

    expect(api.applyDirectResult(
      "shared",
      (ctx) => ctx.complete(),
      "skip",
      "frame"
    )).toEqual(ok({
      key: "shared",
      policy: "skip",
      applied: false,
      status: "skipped"
    }));
    expect(api.applyDirectResult(
      "shared",
      (ctx) => ctx.complete(),
      "spawn",
      "frame"
    ).ok).toBe(false);

    expect(api.applyDirect("shared", (ctx) => ctx.complete(), "restart", "frame")).toBe(true);
    expect(api.effect.has("shared")).toBe(false);
    expect(api.direct.has("shared")).toBe(true);
  });

  it("returns Result errors for invalid facade task specs", () => {
    const api = createInsereApi();

    expect(api.applyDirectResult(
      "",
      (ctx) => ctx.complete(),
      "restart",
      "frame"
    ).ok).toBe(false);
    expect(api.applyEffectResult("", sleep(1), "restart").ok).toBe(false);
  });

  it("facade explicit restart methods supersede the other runtime too", () => {
    const api = createInsereApi();

    api.waitFrame("shared", (ctx) => ctx.complete());
    api.restartEffect("shared", sleep(10));

    expect(api.direct.has("shared")).toBe(false);
    expect(api.effect.has("shared")).toBe(true);

    api.restartDirect("shared", (ctx) => ctx.waitFrame());

    expect(api.direct.has("shared")).toBe(true);
    expect(api.effect.has("shared")).toBe(false);
  });

  it("logs duplicate spawn policy bugs without throwing from Result APIs", () => {
    const logs = createBufferedInsereLogger();
    const api = createInsereApi({ logger: logs.logger });

    api.applyEffect("shared", sleep(10));
    const result = api.applyDirectResult(
      "shared",
      (ctx) => ctx.complete(),
      "spawn",
      "frame"
    );

    expect(result.ok).toBe(false);
    expect(logs.records).toHaveLength(1);
    expect(logs.records[0]).toMatchObject({
      level: "error",
      kind: "bug",
      runtime: "api",
      operation: "applyDirectResult",
      key: "shared",
      policy: "spawn",
      frame: 0,
      now: 0,
      delta: 0,
      data: { start: "frame" }
    });
  });

  it("propagates host request ids into bug logs", () => {
    const logs = createBufferedInsereLogger();
    let requestId = "req-1";
    const api = createInsereApi({
      logger: logs.logger,
      requestId: () => requestId
    });

    api.applyEffect("shared", sleep(10));
    api.applyDirectResult(
      "shared",
      (ctx) => ctx.complete(),
      "spawn",
      "frame"
    );
    requestId = "req-2";
    api.applyEffectResult("", sleep(1), "restart");

    expect(logs.records.map((record) => record.requestId)).toEqual([
      "req-1",
      "req-2"
    ]);
  });

  it("does not call request id providers when logging is disabled", () => {
    let reads = 0;
    const api = createInsereApi({
      requestId: () => {
        reads += 1;
        return "req";
      }
    });

    api.applyEffect("shared", sleep(10));
    const result = api.applyDirectResult(
      "shared",
      (ctx) => ctx.complete(),
      "spawn",
      "frame"
    );

    expect(result.ok).toBe(false);
    expect(reads).toBe(0);
  });

  it("logs invalid task specs returned through Result APIs", () => {
    const logs = createBufferedInsereLogger();
    const api = createInsereApi({ logger: logs.logger });

    const result = api.applyEffectResult("", sleep(1), "restart");

    expect(result.ok).toBe(false);
    expect(logs.records).toHaveLength(1);
    expect(logs.records[0]).toMatchObject({
      level: "error",
      kind: "bug",
      operation: "applyEffectResult",
      key: "",
      policy: "restart"
    });
  });

  it("logs uncaught runtime bugs and rethrows the original error", () => {
    const logs = createBufferedInsereLogger();
    const api = createInsereApi({ logger: logs.logger });
    const error = new Error("boom");

    api.waitFrame("broken", () => {
      throw error;
    });

    expect(() => api.tick(16)).toThrow(error);
    expect(logs.records).toHaveLength(1);
    expect(logs.records[0]).toMatchObject({
      level: "error",
      kind: "bug",
      operation: "tick",
      frame: 1,
      now: 16,
      delta: 0,
      data: { tickNow: 16 },
      cause: error
    });
  });

  it("does not let logger failures hide runtime failures", () => {
    const original = new Error("task failed");
    const loggerFailure = new Error("logger failed");
    const api = createInsereApi({
      logger: () => {
        throw loggerFailure;
      }
    });

    api.waitFrame("broken", () => {
      throw original;
    });

    expect(() => api.tick(1)).toThrow(original);
  });
});
