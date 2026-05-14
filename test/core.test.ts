import { describe, expect, it } from "vitest";

import {
  DirectInsereTask,
  DirectInsereTaskScope,
  applyDirectTask,
  applyDirectTaskResult,
  directFrameTask,
  directTask,
  matchResult,
  ok
} from "../src/index.js";

describe("DirectInsereTask", () => {
  it("restarts a keyed task so only the latest work runs", () => {
    const events: number[] = [];
    const runtime = new DirectInsereTask<unknown, number>({
      dispatch: (event) => events.push(event)
    });

    for (let index = 0; index < 100; index += 1) {
      runtime.restart("projection", (ctx) => {
        if (ctx.frame === 0) {
          ctx.waitFrame();
          return;
        }

        ctx.dispatch(index);
        ctx.complete();
      });
    }

    runtime.tick(1);

    expect(events).toEqual([99]);
  });

  it("issues a fresh non-aborted signal across in-place restart", () => {
    const runtime = new DirectInsereTask();
    const signals: AbortSignal[] = [];

    runtime.spawn("slot", (ctx) => {
      signals.push(ctx.signal);
      ctx.waitFrame();
    });
    runtime.restart("slot", (ctx) => {
      signals.push(ctx.signal);
      ctx.complete();
    });

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("clears wait state when restarting an in-place slot mid delay", () => {
    const events: string[] = [];
    const runtime = new DirectInsereTask<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    runtime.spawn("slot", (ctx) => {
      ctx.sleep(1000);
    });
    runtime.tick(0);
    expect(events).toEqual([]);

    runtime.restart("slot", (ctx) => {
      ctx.dispatch("restarted");
      ctx.complete();
    });

    expect(events).toEqual(["restarted"]);
    expect(runtime.size).toBe(0);
  });

  it("continues tasks waiting for the next frame", () => {
    const events: number[] = [];
    const runtime = new DirectInsereTask<unknown, number>({
      dispatch: (event) => events.push(event)
    });

    for (let index = 0; index < 3; index += 1) {
      runtime.spawn(`task:${index}`, (ctx) => {
        if (ctx.frame === 0) {
          ctx.waitFrame();
          return;
        }

        ctx.dispatch(index);
        ctx.complete();
      });
    }

    runtime.tick(1);

    expect(events).toEqual([0, 1, 2]);
    expect(runtime.size).toBe(0);
  });

  it("registers tasks directly for next-frame continuation", () => {
    const events: number[] = [];
    const runtime = new DirectInsereTask<unknown, number>({
      dispatch: (event) => events.push(event)
    });

    for (let index = 0; index < 3; index += 1) {
      runtime.waitFrame(`task:${index}`, (ctx) => {
        ctx.dispatch(index);
        ctx.complete();
      });
    }

    expect(events).toEqual([]);
    runtime.tick(1);

    expect(events).toEqual([0, 1, 2]);
    expect(runtime.size).toBe(0);
  });

  it("rejects duplicate next-frame task keys", () => {
    const runtime = new DirectInsereTask();

    runtime.waitFrame("task", (ctx) => ctx.complete());

    expect(() => runtime.waitFrame("task", (ctx) => ctx.complete())).toThrow(
      "DirectInsereTask already exists: task"
    );
  });

  it("cancels tasks by prefix and runs finalizers", () => {
    const events: string[] = [];
    const runtime = new DirectInsereTask<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    runtime.spawn("asset:1", (ctx) => {
      ctx.onCancel(() => ctx.dispatch("cleanup:1"));
      ctx.waitFrame();
    });
    runtime.spawn("asset:2", (ctx) => {
      ctx.onCancel(() => ctx.dispatch("cleanup:2"));
      ctx.waitFrame();
    });
    runtime.spawn("preview:1", (ctx) => {
      ctx.onCancel(() => ctx.dispatch("cleanup:preview"));
      ctx.waitFrame();
    });

    expect(runtime.cancelGroup("asset:")).toBe(2);

    expect(events).toEqual(["cleanup:1", "cleanup:2"]);
    expect(runtime.keys()).toEqual(["preview:1"]);
  });

  it("cancels indexed nested task groups by prefix", () => {
    const runtime = new DirectInsereTask();

    runtime.waitFrame("entity:1:script:move", (ctx) => ctx.complete());
    runtime.waitFrame("entity:1:animation:idle", (ctx) => ctx.complete());
    runtime.waitFrame("entity:2:script:move", (ctx) => ctx.complete());
    runtime.waitFrame("preview:1", (ctx) => ctx.complete());

    expect(runtime.cancelGroup("entity:1:")).toBe(2);
    expect(runtime.keys()).toEqual(["entity:2:script:move", "preview:1"]);

    expect(runtime.cancelGroup("entity:")).toBe(1);
    expect(runtime.keys()).toEqual(["preview:1"]);
  });

  it("runs multiple direct finalizers in reverse registration order", () => {
    const events: string[] = [];
    const runtime = new DirectInsereTask();

    runtime.spawn("asset:1", (ctx) => {
      ctx.onCancel(() => events.push("first"));
      ctx.onCancel(() => events.push("second"));
      ctx.waitFrame();
    });

    runtime.cancel("asset:1");

    expect(events).toEqual(["second", "first"]);
  });

  it("removes direct finalizers with the returned disposer", () => {
    const events: string[] = [];
    const runtime = new DirectInsereTask();

    runtime.spawn("asset:1", (ctx) => {
      const dispose = ctx.onCancel(() => events.push("removed"));
      ctx.onCancel(() => events.push("kept"));
      dispose();
      ctx.waitFrame();
    });

    runtime.cancel("asset:1");

    expect(events).toEqual(["kept"]);
  });

  it("creates AbortSignal lazily and aborts it on cancellation", () => {
    let signal: AbortSignal | undefined;
    const runtime = new DirectInsereTask();

    runtime.spawn("io", (ctx) => {
      signal = ctx.signal;
      ctx.waitFrame();
    });

    expect(signal?.aborted).toBe(false);
    runtime.cancel("io");
    expect(signal?.aborted).toBe(true);
  });

  it("reports frame, now, delta, and snapshots", () => {
    const runtime = new DirectInsereTask();

    runtime.spawn("timer", (ctx) => {
      ctx.sleep(10);
    });
    runtime.tick(5);

    expect(runtime.frame).toBe(1);
    expect(runtime.now).toBe(5);
    expect(runtime.delta).toBe(0);
    expect(runtime.snapshot()).toEqual({
      frame: 1,
      now: 5,
      delta: 0,
      size: 1,
      entries: [{ key: "timer", wait: "delay" }]
    });
  });

  it("applies direct restart policy by default", () => {
    const events: string[] = [];
    const runtime = new DirectInsereTask<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    applyDirectTask(runtime, directFrameTask("projection", (ctx) => {
      ctx.dispatch("old");
    }));
    applyDirectTask(runtime, directFrameTask("projection", (ctx) => {
      ctx.dispatch("new");
    }));

    runtime.tick(1);

    expect(events).toEqual(["new"]);
  });

  it("applies direct skip policy without replacing active work", () => {
    const events: string[] = [];
    const runtime = new DirectInsereTask<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    expect(applyDirectTask(runtime, directFrameTask("projection", (ctx) => {
      ctx.dispatch("old");
    }, "skip"))).toBe(true);
    expect(applyDirectTask(runtime, directFrameTask("projection", (ctx) => {
      ctx.dispatch("new");
    }, "skip"))).toBe(false);

    runtime.tick(1);

    expect(events).toEqual(["old"]);
  });

  it("returns Result reports for direct task policy application", () => {
    const runtime = new DirectInsereTask();

    expect(applyDirectTaskResult(
      runtime,
      directFrameTask("refresh", (ctx) => ctx.complete(), "restart")
    )).toEqual(ok({
      key: "refresh",
      policy: "restart",
      applied: true,
      status: "started"
    }));
    expect(applyDirectTaskResult(
      runtime,
      directFrameTask("refresh", (ctx) => ctx.complete(), "restart")
    )).toEqual(ok({
      key: "refresh",
      policy: "restart",
      applied: true,
      status: "restarted"
    }));
    expect(applyDirectTaskResult(
      runtime,
      directFrameTask("projection", (ctx) => ctx.complete(), "skip")
    )).toEqual(ok({
      key: "projection",
      policy: "skip",
      applied: true,
      status: "started"
    }));
    expect(applyDirectTaskResult(
      runtime,
      directFrameTask("projection", (ctx) => ctx.complete(), "skip")
    )).toEqual(ok({
      key: "projection",
      policy: "skip",
      applied: false,
      status: "skipped"
    }));

    const duplicate = applyDirectTaskResult(
      runtime,
      directFrameTask("projection", (ctx) => ctx.complete(), "spawn")
    );

    expect(duplicate.ok).toBe(false);
    expect(matchResult(duplicate, {
      ok: () => "",
      err: (error) => String(error)
    })).toContain("DirectInsereTask already exists: projection");
  });

  it("applies direct spawn policy through duplicate-key checks", () => {
    const runtime = new DirectInsereTask();

    expect(applyDirectTask(runtime, directFrameTask("projection", (ctx) => {
      ctx.complete();
    }, "spawn"))).toBe(true);
    expect(() => applyDirectTask(runtime, directFrameTask("projection", (ctx) => {
      ctx.complete();
    }, "spawn"))).toThrow("DirectInsereTask already exists: projection");
  });

  it("runs direct task specs immediately by default", () => {
    const events: string[] = [];
    const runtime = new DirectInsereTask<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    applyDirectTask(runtime, directTask("command", (ctx) => {
      ctx.dispatch("run");
    }));

    expect(events).toEqual(["run"]);
    expect(runtime.size).toBe(0);
  });

  it("scopes direct tasks with prefixed keys and snapshots", () => {
    const runtime = new DirectInsereTask();
    const scope = new DirectInsereTaskScope(runtime).child("editor", "projection");

    scope.waitFrame("primary", (ctx) => ctx.complete());
    scope.waitFrame("preview", (ctx) => ctx.complete());
    runtime.waitFrame("outside", (ctx) => ctx.complete());

    expect(scope.keys()).toEqual([
      "editor:projection:primary",
      "editor:projection:preview"
    ]);
    expect(scope.snapshot()).toEqual({
      frame: 0,
      now: 0,
      delta: 0,
      size: 2,
      entries: [
        { key: "editor:projection:primary", wait: "frame" },
        { key: "editor:projection:preview", wait: "frame" }
      ]
    });
    expect(scope.cancelScope()).toBe(2);
    expect(runtime.keys()).toEqual(["outside"]);
  });

  it("applies direct task policy through a scope", () => {
    const events: string[] = [];
    const runtime = new DirectInsereTask<unknown, string>({
      dispatch: (event) => events.push(event)
    });
    const scope = new DirectInsereTaskScope(runtime).child("editor");

    expect(scope.applyTask("autosave", (ctx) => {
      ctx.dispatch("old");
    }, "skip", "frame")).toBe(true);
    expect(scope.applyTask("autosave", (ctx) => {
      ctx.dispatch("new");
    }, "skip", "frame")).toBe(false);

    runtime.tick(1);

    expect(events).toEqual(["old"]);
  });

  it("returns scoped Result reports for direct task policy application", () => {
    const runtime = new DirectInsereTask();
    const scope = new DirectInsereTaskScope(runtime).child("editor");

    expect(scope.applyTaskResult(
      "autosave",
      (ctx) => ctx.complete(),
      "skip",
      "frame"
    )).toEqual(ok({
      key: "editor:autosave",
      policy: "skip",
      applied: true,
      status: "started"
    }));
    expect(scope.applyTaskResult(
      "autosave",
      (ctx) => ctx.complete(),
      "skip",
      "frame"
    )).toEqual(ok({
      key: "editor:autosave",
      policy: "skip",
      applied: false,
      status: "skipped"
    }));
  });
});
