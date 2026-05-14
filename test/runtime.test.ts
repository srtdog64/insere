import { describe, expect, it } from "vitest";

import { Insere, delay, frame, fromPromise, idle } from "../src/index.js";

describe("Insere", () => {
  it("runs frame-aware routines only after the next tick", () => {
    const events: string[] = [];
    const insere = new Insere({ dispatch: (event: string) => events.push(event) });

    insere.restart("drag", function* (ctx) {
      ctx.dispatch("start");
      yield frame();
      ctx.dispatch("frame");
    });

    expect(events).toEqual(["start"]);
    insere.tick(0);
    expect(events).toEqual(["start", "frame"]);
  });

  it("supersedes routines with the same key", () => {
    const events: string[] = [];
    const insere = new Insere({ dispatch: (event: string) => events.push(event) });

    insere.restart("projection", function* (ctx) {
      yield delay(100);
      ctx.dispatch("old");
    });
    insere.restart("projection", function* (ctx) {
      yield delay(10);
      ctx.dispatch("new");
    });

    insere.tick(10);
    expect(events).toEqual(["new"]);
    insere.tick(100);
    expect(events).toEqual(["new"]);
  });

  it("runs prior finalizer before the new routine starts on restart", () => {
    const events: string[] = [];
    const insere = new Insere({ dispatch: (event: string) => events.push(event) });

    insere.restart("slot", function* (ctx) {
      ctx.onCancel(() => events.push("cleanup-old"));
      yield delay(100);
    });
    insere.restart("slot", function* (ctx) {
      events.push("started-new");
      ctx.dispatch("done-new");
    });

    expect(events).toEqual(["cleanup-old", "started-new", "done-new"]);
    expect(insere.size).toBe(0);
  });

  it("issues a fresh non-aborted signal across in-place restart", () => {
    const insere = new Insere();
    const signals: AbortSignal[] = [];

    insere.spawn("slot", function* (ctx) {
      signals.push(ctx.signal);
      yield frame();
    });
    insere.restart("slot", function* (ctx) {
      signals.push(ctx.signal);
    });

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("scopes onCancel registration to the routine that registered it", () => {
    const events: string[] = [];
    const insere = new Insere({ dispatch: (event: string) => events.push(event) });

    insere.spawn("first", function* (ctx) {
      ctx.onCancel(() => events.push("cleanup-first"));
      yield delay(100);
    });
    insere.spawn("second", function* (ctx) {
      ctx.onCancel(() => events.push("cleanup-second"));
      yield delay(100);
    });

    insere.cancel("first");
    expect(events).toEqual(["cleanup-first"]);

    insere.cancel("second");
    expect(events).toEqual(["cleanup-first", "cleanup-second"]);
  });

  it("scopes signal access to the routine that requested it", () => {
    const insere = new Insere();
    let firstSignal!: AbortSignal;
    let secondSignal!: AbortSignal;

    insere.spawn("first", function* (ctx) {
      firstSignal = ctx.signal;
      yield delay(100);
    });
    insere.spawn("second", function* (ctx) {
      secondSignal = ctx.signal;
      yield delay(100);
    });

    expect(firstSignal).not.toBe(secondSignal);
    expect(firstSignal.aborted).toBe(false);
    expect(secondSignal.aborted).toBe(false);

    insere.cancel("first");

    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);
  });

  it("clears wait state when restarting an in-place slot mid delay", () => {
    const events: string[] = [];
    const insere = new Insere({ dispatch: (event: string) => events.push(event) });

    insere.spawn("slot", function* () {
      yield delay(1000);
      // unreachable in this test
    });
    insere.tick(0);
    expect(events).toEqual([]);

    insere.restart("slot", function* (ctx) {
      ctx.dispatch("restarted");
    });

    expect(events).toEqual(["restarted"]);
    expect(insere.size).toBe(0);
  });

  it("runs idle routines only when idle is explicitly pumped", () => {
    const events: string[] = [];
    const insere = new Insere({ dispatch: (event: string) => events.push(event) });

    insere.restart("idle-work", function* (ctx) {
      yield idle();
      ctx.dispatch("idle");
    });

    insere.tick(16);
    expect(events).toEqual([]);
    insere.runIdle();
    expect(events).toEqual(["idle"]);
  });

  it("bridges promises at I/O boundaries", async () => {
    const events: string[] = [];
    const insere = new Insere({ dispatch: (event: string) => events.push(event) });
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });

    insere.restart("io", function* (ctx) {
      yield fromPromise(promise);
      ctx.dispatch("done");
    });

    insere.tick(0);
    expect(events).toEqual([]);
    resolve();
    await promise;
    await Promise.resolve();
    insere.tick(16);
    expect(events).toEqual(["done"]);
  });

  it("exposes runtime keys and activity by key", () => {
    const insere = new Insere();

    insere.restart("projection", function* () {
      yield delay(10);
    });

    expect(insere.has("projection")).toBe(true);
    expect(insere.keys()).toEqual(["projection"]);
    insere.tick(10);
    expect(insere.has("projection")).toBe(false);
    expect(insere.keys()).toEqual([]);
  });

  it("returns a stable scheduler snapshot", () => {
    const insere = new Insere();

    insere.restart("frame", function* () {
      yield frame();
    });
    insere.restart("idle", function* () {
      yield idle();
    });
    insere.restart("timer", function* () {
      yield delay(10);
    });

    expect(insere.snapshot()).toEqual({
      frame: 0,
      now: 0,
      delta: 0,
      size: 3,
      entries: [
        { key: "frame", wait: "frame" },
        { key: "idle", wait: "idle" },
        { key: "timer", wait: "delay" }
      ]
    });
  });

  it("exposes host clock state on the runtime and context", () => {
    const events: string[] = [];
    const insere = new Insere({ dispatch: (event: string) => events.push(event) });

    expect(insere.frame).toBe(0);
    expect(insere.now).toBe(0);
    insere.restart("clock", function* (ctx) {
      yield frame();
      ctx.dispatch(`${ctx.frame}:${ctx.now}`);
    });
    insere.tick(32);

    expect(insere.frame).toBe(1);
    expect(insere.now).toBe(32);
    expect(events).toEqual(["1:32"]);
  });

  it("exposes the routine key on context", () => {
    const events: string[] = [];
    const insere = new Insere({ dispatch: (event: string) => events.push(event) });

    insere.restart("projection", function* (ctx) {
      ctx.dispatch(ctx.key);
    });

    expect(events).toEqual(["projection"]);
  });

  it("runs cancellation finalizers in reverse registration order", () => {
    const events: string[] = [];
    const insere = new Insere({ dispatch: (event: string) => events.push(event) });

    insere.restart("session", function* (ctx) {
      ctx.onCancel(() => ctx.dispatch("first"));
      ctx.onCancel(() => ctx.dispatch("second"));
      yield delay(10);
    });

    expect(insere.cancel("session")).toBe(true);
    expect(events).toEqual(["second", "first"]);
  });

  it("runs cancellation finalizers when restarting and cancelling all", () => {
    const events: string[] = [];
    const insere = new Insere({ dispatch: (event: string) => events.push(event) });

    insere.restart("a", function* (ctx) {
      ctx.onCancel(() => ctx.dispatch("old-a"));
      yield delay(10);
    });
    insere.restart("a", function* (ctx) {
      ctx.onCancel(() => ctx.dispatch("new-a"));
      yield delay(10);
    });
    insere.restart("b", function* (ctx) {
      ctx.onCancel(() => ctx.dispatch("b"));
      yield delay(10);
    });

    expect(events).toEqual(["old-a"]);
    insere.cancelAll();
    expect(events).toEqual(["old-a", "new-a", "b"]);
  });

  it("requires explicit cancelAll instead of empty cancelGroup", () => {
    const insere = new Insere();

    insere.restart("projection", function* () {
      yield delay(10);
    });

    expect(() => insere.cancelGroup("")).toThrow(
      "Insere cancelGroup prefix must not be empty. Use cancelAll() explicitly."
    );
    expect(insere.has("projection")).toBe(true);
  });

  it("allows cancellation finalizers to be unregistered", () => {
    const events: string[] = [];
    const insere = new Insere({ dispatch: (event: string) => events.push(event) });

    insere.restart("session", function* (ctx) {
      const unregister = ctx.onCancel(() => ctx.dispatch("cleanup"));
      unregister();
      yield delay(10);
    });

    insere.cancel("session");
    expect(events).toEqual([]);
  });

  it("does not let failure reporters prevent routine cleanup", () => {
    const insere = new Insere({
      onFailure: () => {
        throw new Error("report failed");
      }
    });

    insere.restart("broken", function* () {
      yield frame();
      throw new Error("routine failed");
    });

    expect(() => insere.tick(1)).toThrow("routine failed");
    expect(insere.has("broken")).toBe(false);
  });
});
