import { describe, expect, it } from "vitest";

import {
  abortable,
  createBufferedInsereLogger,
  createInsereApi,
  createInsereHostAdapter,
  createInsereMailbox,
  dispatch,
  sleep,
  waitEvent
} from "../src/index.js";

describe("Insere framework layers", () => {
  it("delivers inbound mailbox events to waiting effects", async () => {
    const events: string[] = [];
    const mailbox = createInsereMailbox<{ type: string; value: string }>();
    const api = createInsereApi<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    api.applyEffect(
      "pointer",
      function* (context) {
        const event = yield* waitEvent(
          mailbox,
          (item) => item.type === "pointerup"
        )(context);
        yield* dispatch(event.value)(context);
      }
    );

    expect(mailbox.waiters).toBe(1);
    expect(mailbox.emit({ type: "pointerup", value: "done" })).toBe(1);
    await Promise.resolve();
    api.tick(1);

    expect(events).toEqual(["done"]);
    expect(api.size).toBe(0);
  });

  it("can consume only the first matching mailbox waiter", async () => {
    const mailbox = createInsereMailbox<string>();
    const events: string[] = [];
    const waits = [
      mailbox.wait().then((event) => events.push(`first:${event}`)),
      mailbox.wait().then((event) => events.push(`second:${event}`)),
      mailbox.wait((event) => event === "other")
        .then((event) => events.push(`other:${event}`))
    ];

    expect(mailbox.waiters).toBe(3);
    expect(mailbox.emitOne("commit")).toBe(1);
    await Promise.resolve();

    expect(events).toEqual(["first:commit"]);
    expect(mailbox.waiters).toBe(2);
    expect(mailbox.emit("commit")).toBe(1);
    expect(mailbox.emit("other")).toBe(1);
    await Promise.all(waits);

    expect(events).toEqual(["first:commit", "second:commit", "other:other"]);
    expect(mailbox.waiters).toBe(0);
  });

  it("buffers consume-one mailbox events when nothing matches", async () => {
    const mailbox = createInsereMailbox<string>({ buffer: "queue" });

    mailbox.wait((event) => event === "commit");
    expect(mailbox.emitOne("miss")).toBe(0);
    await expect(mailbox.wait()).resolves.toBe("miss");
  });

  it("removes mailbox waiters when the owning task is cancelled", () => {
    const events: string[] = [];
    const mailbox = createInsereMailbox<string>();
    const api = createInsereApi<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    api.applyEffect("wait", waitEvent(mailbox));
    expect(mailbox.waiters).toBe(1);

    expect(api.cancel("wait")).toBe(true);
    expect(mailbox.waiters).toBe(0);
    expect(mailbox.emit("late")).toBe(0);
    api.tick(1);

    expect(events).toEqual([]);
  });

  it("compacts mailbox waiters after abort-heavy cancellation", async () => {
    const mailbox = createInsereMailbox<number>({ buffer: "queue" });
    const controllers = Array.from(
      { length: 256 },
      () => new AbortController()
    );

    const waits = controllers.map((controller) =>
      mailbox.wait(undefined, { signal: controller.signal })
    );
    const settled = Promise.allSettled(waits);

    expect(mailbox.waiters).toBe(controllers.length);

    for (const controller of controllers) {
      controller.abort();
    }

    expect(mailbox.waiters).toBe(0);
    expect(mailbox.emit(7)).toBe(0);
    await expect(mailbox.wait()).resolves.toBe(7);
    await expect(settled).resolves.toSatisfy(
      (results: PromiseSettledResult<number>[]) =>
        results.every((result) => result.status === "rejected")
    );
  });

  it("applies explicit bounded mailbox buffering", async () => {
    const mailbox = createInsereMailbox<number>({
      buffer: "bounded",
      capacity: 2,
      overflow: "drop-oldest"
    });

    mailbox.emit(1);
    mailbox.emit(2);
    mailbox.emit(3);

    await expect(mailbox.wait()).resolves.toBe(2);
    await expect(mailbox.wait()).resolves.toBe(3);
  });

  it("notifies hot event bus subscribers without delivered-count bookkeeping", () => {
    const host = createInsereHostAdapter<
      unknown,
      never,
      { readonly amount: number }
    >();
    let total = 0;

    host.subscribeTo("entity:1", (event) => {
      total += event.amount;
    });
    host.notifyTo("entity:1", { amount: 3 });
    host.notifyTo("entity:2", { amount: 7 });

    expect(total).toBe(3);
  });

  it("swallows task failures with logAndStop supervision", () => {
    const failures: string[] = [];
    const api = createInsereApi({
      supervision: {
        policy: "logAndStop",
        onFailure: (failure) => failures.push(failure.key ?? "")
      }
    });

    api.waitFrame("broken", () => {
      throw new Error("boom");
    });

    expect(() => api.tick(1)).not.toThrow();
    expect(failures).toEqual(["broken"]);
    expect(api.size).toBe(0);
  });

  it("continues the other runtime after a supervised direct tick failure", () => {
    const events: string[] = [];
    const api = createInsereApi<unknown, string>({
      dispatch: (event) => events.push(event),
      supervision: { policy: "logAndStop" }
    });

    api.waitFrame("broken", () => {
      throw new Error("boom");
    });
    api.applyEffect("effect", dispatch("effect"));

    expect(() => api.tick(1)).not.toThrow();
    expect(events).toEqual(["effect"]);
  });

  it("does not let failure reporters prevent task cleanup", () => {
    const logs = createBufferedInsereLogger();
    const api = createInsereApi({
      logger: logs.logger,
      supervision: {
        policy: "logAndStop",
        onFailure: () => {
          throw new Error("report failed");
        }
      }
    });

    api.waitFrame("broken", () => {
      throw new Error("task failed");
    });

    expect(() => api.tick(1)).not.toThrow();
    expect(api.has("broken")).toBe(false);
    expect(logs.records.some((record) =>
      record.data?.["reporter"] === "supervision.onFailure"
    )).toBe(true);
  });

  it("dispatches task failures with dispatchAndStop supervision", () => {
    const events: string[] = [];
    const api = createInsereApi<unknown, string>({
      dispatch: (event) => events.push(event),
      supervision: {
        policy: "dispatchAndStop",
        toEvent: (failure) => `failed:${failure.key}`
      }
    });

    api.waitFrame("broken", () => {
      throw new Error("boom");
    });
    api.tick(1);

    expect(events).toEqual(["failed:broken"]);
  });

  it("converts task failures into Result values with convertToResult supervision", () => {
    const failedKeys: string[] = [];
    const api = createInsereApi({
      supervision: {
        policy: "convertToResult",
        onResult: (result) => {
          if (!result.ok) {
            failedKeys.push(result.error.key ?? "");
          }
        }
      }
    });

    api.waitFrame("broken", () => {
      throw new Error("boom");
    });
    api.tick(1);

    expect(failedKeys).toEqual(["broken"]);
  });

  it("restarts supervised tasks up to a bounded policy limit", () => {
    const events: string[] = [];
    let runs = 0;
    const api = createInsereApi<unknown, string>({
      dispatch: (event) => events.push(event),
      supervision: {
        policy: "restart",
        maxRestarts: 1
      }
    });

    api.waitFrame("flaky", (context) => {
      runs += 1;

      if (runs === 1) {
        throw new Error("first");
      }

      context.dispatch("ok");
    });

    expect(() => api.tick(1)).not.toThrow();
    expect(api.has("flaky")).toBe(true);

    api.tick(2);

    expect(events).toEqual(["ok"]);
    expect(api.size).toBe(0);
  });

  it("bubbles supervised restart failures after the restart limit", () => {
    const api = createInsereApi({
      supervision: {
        policy: "restart",
        maxRestarts: 0
      }
    });

    api.waitFrame("broken", () => {
      throw new Error("boom");
    });

    expect(() => api.tick(1)).toThrow("boom");
  });

  it("validates supervision restart limits", () => {
    expect(() =>
      createInsereApi({
        supervision: {
          policy: "restart",
          maxRestarts: -1
        }
      })
    ).toThrow("Insere supervision maxRestarts must be a non-negative integer.");
  });

  it("combines api, mailbox, and host clock in the host adapter", async () => {
    const events: string[] = [];
    const host = createInsereHostAdapter<unknown, string, string>({
      dispatch: (event) => events.push(event),
      mailbox: { buffer: "latest" }
    });

    host.api.applyEffect("input", function* (context) {
      const event = yield* host.waitEvent((item) => item === "commit")(context);
      yield* dispatch(event)(context);
    });

    expect(host.emit("commit")).toBe(1);
    await Promise.resolve();
    host.tick(16);

    expect(host.frame).toBe(1);
    expect(events).toEqual(["commit"]);
  });

  it("exposes consume-one mailbox delivery from the host adapter", async () => {
    const events: string[] = [];
    const host = createInsereHostAdapter<unknown, string, string>({
      dispatch: (event) => events.push(event)
    });

    host.api.applyEffect("first", function* (context) {
      const event = yield* host.waitEvent()(context);
      yield* dispatch(`first:${event}`)(context);
    });
    host.api.applyEffect("second", function* (context) {
      const event = yield* host.waitEvent()(context);
      yield* dispatch(`second:${event}`)(context);
    });

    expect(host.emitOne("commit")).toBe(1);
    await Promise.resolve();
    host.tick(1);

    expect(events).toEqual(["first:commit"]);
    expect(host.mailbox.waiters).toBe(1);
  });

  it("lets host event bus subscriptions follow external abort signals", () => {
    const host = createInsereHostAdapter<unknown, never, string>();
    const controller = new AbortController();
    const events: string[] = [];

    host.subscribeTo(
      "entity:1",
      (event) => events.push(event),
      { signal: controller.signal }
    );

    expect(host.emitTo("entity:1", "first")).toBe(1);
    controller.abort();
    expect(host.eventBus.listeners).toBe(0);
    expect(host.emitTo("entity:1", "late")).toBe(0);
    expect(events).toEqual(["first"]);
  });

  it("publishes host event bus subscriptions without buffering", async () => {
    const host = createInsereHostAdapter<unknown, never, string>({
      eventBus: { buffer: "queue" }
    });
    const events: string[] = [];

    host.subscribeTo("entity:1", (event) => events.push(event));

    expect(host.publishTo("entity:1", "direct")).toBe(1);
    expect(host.publishTo("entity:2", "dropped")).toBe(0);
    expect(events).toEqual(["direct"]);

    host.emitTo("entity:2", "queued");
    await expect(host.eventBus.wait("entity:2")).resolves.toBe("queued");
  });

  it("lets host event bus listener failures bubble", () => {
    const host = createInsereHostAdapter<unknown, never, string>();

    host.subscribeTo("entity:1", () => {
      throw new Error("listener failed");
    });

    expect(() => host.publishTo("entity:1", "event")).toThrow(
      "listener failed"
    );
  });

  it("exposes AbortSignal I/O convention through abortable effects", () => {
    let aborted = false;
    const api = createInsereApi();

    api.applyEffect(
      "io",
      abortable((signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => undefined);
      })
    );

    expect(api.cancel("io")).toBe(true);
    expect(aborted).toBe(true);
  });

  it("keeps expected domain failures expressible with Result effects", () => {
    const events: string[] = [];
    const api = createInsereApi<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    api.applyEffect(
      "domain",
      function* (context) {
        yield* sleep(1)(context);
        yield* dispatch("handled")(context);
      }
    );

    api.tick(1);

    expect(events).toEqual(["handled"]);
  });
});
