import { describe, expect, it } from "vitest";

import {
  Insere,
  InsereTaskScope,
  access,
  acquireUseRelease,
  appError,
  applyTask,
  applyTaskResult,
  asyncEffect,
  attempt,
  awaitPromise,
  dispatch,
  err,
  currentDelta,
  currentFrame,
  currentKey,
  currentTime,
  fail,
  ensuring,
  flatMap,
  forEach,
  isErr,
  isOk,
  map,
  matchResult,
  onCancel,
  ok,
  repeat,
  recover,
  restartTask,
  sequence,
  sleep,
  sleepUntil,
  succeed,
  sync,
  tap,
  task,
  taskGroup,
  taskKey,
  toRoutine,
  unless,
  when,
  whileEffect,
  waitFrame,
  waitFrames,
  waitIdle
} from "../src/index.js";

describe("Insere effect layer", () => {
  it("adapts dispatch effects into runtime routines", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    insere.restart("event", toRoutine(dispatch("ready")));

    expect(events).toEqual(["ready"]);
    expect(insere.size).toBe(0);
  });

  it("keeps sleep effects suspended until their delay elapses", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    insere.restart(
      "timer",
      toRoutine(sequence<unknown, string>([sleep(25), dispatch("late")]))
    );

    insere.tick(24);
    expect(events).toEqual([]);
    insere.tick(25);
    expect(events).toEqual(["late"]);
  });

  it("keeps frame effects suspended until the next host tick", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    insere.restart(
      "frame",
      toRoutine(sequence<unknown, string>([dispatch("start"), waitFrame(), dispatch("next")]))
    );

    expect(events).toEqual(["start"]);
    insere.tick(0);
    expect(events).toEqual(["start", "next"]);
  });

  it("waits for multiple host frames", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    insere.restart(
      "frames",
      toRoutine(sequence<unknown, string>([waitFrames(2), dispatch("done")]))
    );

    insere.tick(0);
    expect(events).toEqual([]);
    insere.tick(16);
    expect(events).toEqual(["done"]);
  });

  it("keeps idle effects suspended until idle work is pumped", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    insere.restart(
      "idle",
      toRoutine(sequence<unknown, string>([waitIdle(), dispatch("idle")]))
    );

    insere.tick(16);
    expect(events).toEqual([]);
    insere.runIdle();
    expect(events).toEqual(["idle"]);
  });

  it("sleeps until an absolute runtime time", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    insere.restart(
      "timer",
      toRoutine(sequence<unknown, string>([sleep(10), sleepUntil(25), dispatch("done")]))
    );

    insere.tick(10);
    expect(events).toEqual([]);
    insere.tick(24);
    expect(events).toEqual([]);
    insere.tick(25);
    expect(events).toEqual(["done"]);
  });

  it("reads host state inside composed effects", () => {
    type State = { readonly count: number };
    type Event = { readonly type: "count"; readonly count: number };
    const events: Event[] = [];
    const insere = new Insere<State, Event>({
      dispatch: (event) => events.push(event),
      getState: () => ({ count: 3 })
    });
    const program = flatMap<State, Event, number, void>(
      access<State, number>((state) => state.count * 2),
      (count) => dispatch<Event>({ type: "count", count })
    );

    insere.restart("state", toRoutine(program));

    expect(events).toEqual([{ type: "count", count: 6 }]);
  });

  it("runs sync effects lazily when the runtime starts the routine", () => {
    const events: number[] = [];
    let runs = 0;
    const insere = new Insere<unknown, number>({
      dispatch: (event) => events.push(event)
    });
    const program = flatMap<unknown, number, number, void>(
      sync(() => {
        runs += 1;
        return runs;
      }),
      (value) => dispatch(value)
    );

    expect(runs).toBe(0);
    insere.restart("sync", toRoutine(program));

    expect(runs).toBe(1);
    expect(events).toEqual([1]);
  });

  it("maps successful effect values before continuing", () => {
    const events: number[] = [];
    const insere = new Insere<unknown, number>({
      dispatch: (event) => events.push(event)
    });
    const program = flatMap<unknown, number, number, void>(
      map(succeed(2), (value) => value + 3),
      (value) => dispatch(value)
    );

    insere.restart("map", toRoutine(program));

    expect(events).toEqual([5]);
  });

  it("resumes promise effects with the fulfilled value", async () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });
    let resolve!: (value: string) => void;
    const promise = new Promise<string>((done) => {
      resolve = done;
    });
    const program = flatMap<unknown, string, string, void>(
      awaitPromise(promise),
      (value) => dispatch(value)
    );

    insere.restart("promise", toRoutine(program));
    insere.tick(0);
    expect(events).toEqual([]);
    resolve("done");
    await promise;
    await Promise.resolve();
    insere.tick(16);

    expect(events).toEqual(["done"]);
  });

  it("captures synchronous failures as effect results", () => {
    const events: string[] = [];
    const error = new Error("boom");
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });
    const program = flatMap<unknown, string, { ok: boolean }, void>(
      map(attempt(fail(error)), (result) => ({ ok: result.ok })),
      (result) => dispatch(result.ok ? "ok" : "failed")
    );

    insere.restart("attempt", toRoutine(program));

    expect(events).toEqual(["failed"]);
  });

  it("creates, narrows, and matches result values", () => {
    const success = ok(3);
    const failure = err(appError("VALIDATION_FAILED", "missing", "Effect"));

    expect(isOk(success)).toBe(true);
    expect(isErr(success)).toBe(false);
    expect(isOk(failure)).toBe(false);
    expect(isErr(failure)).toBe(true);
    expect(matchResult(success, {
      ok: (value) => value + 1,
      err: () => 0
    })).toBe(4);
    expect(matchResult(failure, {
      ok: () => "ok",
      err: (error) => error.message
    })).toBe("missing");
  });

  it("supports positional matchResult callbacks without allocating cases", () => {
    const success = ok(3);
    const failure = err(appError("VALIDATION_FAILED", "missing", "Effect"));

    expect(
      matchResult(
        success,
        (value) => value + 10,
        () => 0
      )
    ).toBe(13);
    expect(
      matchResult(
        failure,
        () => "ok",
        (error) => `${error.message}!`
      )
    ).toBe("missing!");
  });

  it("captures rejected promise effects inside attempt", async () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((_, failWith) => {
      reject = failWith;
    });
    const program = flatMap<unknown, string, boolean, void>(
      map(attempt(awaitPromise(promise)), (result) => result.ok),
      (ok) => dispatch(ok ? "ok" : "failed")
    );

    insere.restart("reject", toRoutine(program));
    reject(new Error("network"));
    await promise.catch(() => undefined);
    await Promise.resolve();
    insere.tick(16);

    expect(events).toEqual(["failed"]);
  });

  it("throws rejected promise effects when they are not captured", async () => {
    const insere = new Insere();
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((_, failWith) => {
      reject = failWith;
    });

    insere.restart("reject", toRoutine(awaitPromise(promise)));
    reject(new Error("network"));
    await promise.catch(() => undefined);
    await Promise.resolve();

    expect(() => insere.tick(16)).toThrow("network");
    expect(insere.size).toBe(0);
  });

  it("recovers from failed effects", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    insere.restart(
      "recover",
      toRoutine(flatMap(recover(fail("nope"), () => succeed("fallback")), dispatch))
    );

    expect(events).toEqual(["fallback"]);
  });

  it("runs ensuring finalizers after success", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    insere.restart(
      "ensure",
      toRoutine(
        sequence<unknown, string>([
          ensuring(dispatch("work"), dispatch("cleanup")),
          dispatch("done")
        ])
      )
    );

    expect(events).toEqual(["work", "cleanup", "done"]);
  });

  it("runs ensuring finalizers after failure before the error escapes", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    expect(() =>
      insere.restart(
        "ensure",
        toRoutine(ensuring(fail(new Error("boom")), dispatch("cleanup")))
      )
    ).toThrow("boom");
    expect(events).toEqual(["cleanup"]);
    expect(insere.size).toBe(0);
  });

  it("acquires, uses, and releases resources after success", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    insere.restart(
      "resource",
      toRoutine(
        acquireUseRelease(
          succeed("socket"),
          (resource) => dispatch(`use:${resource}`),
          (resource) => dispatch(`release:${resource}`)
        )
      )
    );

    expect(events).toEqual(["use:socket", "release:socket"]);
  });

  it("releases resources after use fails", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    expect(() =>
      insere.restart(
        "resource",
        toRoutine(
          acquireUseRelease(
            succeed("socket"),
            () => fail(new Error("use failed")),
            (resource) => dispatch(`release:${resource}`)
          )
        )
      )
    ).toThrow("use failed");
    expect(events).toEqual(["release:socket"]);
  });

  it("does not release when resource acquisition fails", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    expect(() =>
      insere.restart(
        "resource",
        toRoutine(
          acquireUseRelease(
            fail(new Error("acquire failed")),
            () => dispatch("use"),
            () => dispatch("release")
          )
        )
      )
    ).toThrow("acquire failed");
    expect(events).toEqual([]);
  });

  it("registers cancellation callbacks from effects", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    insere.restart(
      "cancel",
      toRoutine(sequence<unknown, string>([
        onCancel((ctx) => ctx.dispatch("cleanup")),
        sleep(10)
      ]))
    );

    expect(insere.cancel("cancel")).toBe(true);
    expect(events).toEqual(["cleanup"]);
  });

  it("runs tap side effects while preserving the source value", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });
    const program = flatMap<unknown, string, string, void>(
      tap(succeed("value"), (value) => dispatch(`tap:${value}`)),
      (value) => dispatch(`next:${value}`)
    );

    insere.restart("tap", toRoutine(program));

    expect(events).toEqual(["tap:value", "next:value"]);
  });

  it("runs conditional effects from when and unless", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    insere.restart(
      "conditions",
      toRoutine(
        sequence<unknown, string>([
          when(true, dispatch("when")),
          when(false, dispatch("skip")),
          unless(false, dispatch("unless")),
          unless(true, dispatch("skip"))
        ])
      )
    );

    expect(events).toEqual(["when", "unless"]);
  });

  it("repeats an effect a fixed number of times", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    insere.restart("repeat", toRoutine(repeat(3, dispatch("tick"))));

    expect(events).toEqual(["tick", "tick", "tick"]);
  });

  it("reads current frame, time, and delta from effect context", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });
    const program = flatMap<unknown, string, number, void>(
      currentFrame(),
      (frame) =>
        flatMap(currentTime(), (time) =>
          flatMap(currentDelta(), (delta) => dispatch(`${frame}:${time}:${delta}`))
        )
    );

    insere.restart("clock", toRoutine(sequence<unknown, string>([sleep(12), program])));
    insere.tick(11);
    expect(events).toEqual([]);
    insere.tick(12);

    expect(events).toEqual(["2:12:1"]);
  });

  it("creates async work lazily when the effect starts", async () => {
    const events: string[] = [];
    let runs = 0;
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });
    const program = flatMap<unknown, string, string, void>(
      asyncEffect(() => {
        runs += 1;
        return Promise.resolve("done");
      }),
      (value) => dispatch(value)
    );

    expect(runs).toBe(0);
    insere.restart("async", toRoutine(sequence<unknown, string>([sleep(5), program])));
    expect(runs).toBe(0);
    insere.tick(5);
    expect(runs).toBe(1);
    await Promise.resolve();
    insere.tick(6);

    expect(events).toEqual(["done"]);
  });

  it("reads the current task key from effect context", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    insere.restart("projection", toRoutine(flatMap(currentKey(), (key) => dispatch(key))));

    expect(events).toEqual(["projection"]);
  });

  it("runs forEach effects sequentially with item indexes", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    insere.restart(
      "items",
      toRoutine(forEach(["a", "b"], (item, index) => dispatch(`${index}:${item}`)))
    );

    expect(events).toEqual(["0:a", "1:b"]);
  });

  it("runs whileEffect until the condition becomes false", () => {
    const events: number[] = [];
    let value = 0;
    const insere = new Insere<unknown, number>({
      dispatch: (event) => events.push(event)
    });

    insere.restart(
      "loop",
      toRoutine(
        whileEffect(
          () => value < 3,
          flatMap(
            sync(() => {
              value += 1;
              return value;
            }),
            (next) => dispatch(next)
          )
        )
      )
    );

    expect(events).toEqual([1, 2, 3]);
  });
});

describe("Insere task layer", () => {
  it("applies restart task policy by default", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    applyTask(insere, task("projection", sequence<unknown, string>([sleep(10), dispatch("old")])));
    applyTask(insere, task("projection", sequence<unknown, string>([sleep(1), dispatch("new")])));

    insere.tick(1);
    expect(events).toEqual(["new"]);
    insere.tick(10);
    expect(events).toEqual(["new"]);
  });

  it("applies skip task policy without replacing active work", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    expect(applyTask(
      insere,
      task("projection", sequence<unknown, string>([sleep(10), dispatch("old")]), "skip")
    )).toBe(true);
    expect(applyTask(
      insere,
      task("projection", sequence<unknown, string>([sleep(1), dispatch("new")]), "skip")
    )).toBe(false);

    insere.tick(1);
    expect(events).toEqual([]);
    insere.tick(10);
    expect(events).toEqual(["old"]);
  });

  it("returns Result reports for task policy application", () => {
    const insere = new Insere();

    expect(applyTaskResult(insere, task("refresh", sleep(10), "restart"))).toEqual(
      ok({
        key: "refresh",
        policy: "restart",
        applied: true,
        status: "started"
      })
    );
    expect(applyTaskResult(insere, task("refresh", sleep(1), "restart"))).toEqual(
      ok({
        key: "refresh",
        policy: "restart",
        applied: true,
        status: "restarted"
      })
    );
    expect(applyTaskResult(insere, task("projection", sleep(10), "skip"))).toEqual(
      ok({
        key: "projection",
        policy: "skip",
        applied: true,
        status: "started"
      })
    );
    expect(applyTaskResult(insere, task("projection", sleep(1), "skip"))).toEqual(
      ok({
        key: "projection",
        policy: "skip",
        applied: false,
        status: "skipped"
      })
    );

    const duplicate = applyTaskResult(
      insere,
      task("projection", sleep(1), "spawn")
    );

    expect(duplicate.ok).toBe(false);
    expect(matchResult(duplicate, {
      ok: () => "",
      err: (error) => String(error)
    })).toContain("Insere routine already exists: projection");
  });

  it("applies spawn task policy through runtime duplicate checks", () => {
    const insere = new Insere();

    expect(applyTask(insere, task("projection", sleep(10), "spawn"))).toBe(true);
    expect(() => applyTask(insere, task("projection", sleep(1), "spawn"))).toThrow(
      "Insere routine already exists: projection"
    );
  });

  it("restarts task declarations by key", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });

    restartTask(
      insere,
      task("projection", sequence<unknown, string>([sleep(100), dispatch("old")]))
    );
    restartTask(
      insere,
      task("projection", sequence<unknown, string>([sleep(10), dispatch("new")]))
    );

    insere.tick(10);
    expect(events).toEqual(["new"]);
    insere.tick(100);
    expect(events).toEqual(["new"]);
  });

  it("groups task cancellation through a scope", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });
    const scope = new InsereTaskScope(insere);

    scope.restart(task("projection:a", sequence<unknown, string>([sleep(10), dispatch("a")])));
    scope.restart(task("projection:b", sequence<unknown, string>([sleep(10), dispatch("b")])));

    expect(scope.cancelGroup("projection:")).toBe(2);
    insere.tick(10);
    expect(events).toEqual([]);
  });

  it("builds stable task keys and group prefixes", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });
    const scope = new InsereTaskScope(insere);

    scope.restart(
      task(taskKey("projection", "primary"), sequence<unknown, string>([sleep(1), dispatch("a")]))
    );
    scope.restart(
      task(taskKey("projection", "preview"), sequence<unknown, string>([sleep(1), dispatch("b")]))
    );

    expect(scope.cancelGroup(taskGroup("projection"))).toBe(2);
    insere.tick(1);
    expect(events).toEqual([]);
  });

  it("creates nested task scopes with prefixed keys", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });
    const scope = new InsereTaskScope(insere).child("editor", "projection");

    expect(scope.key("preview")).toBe("editor:projection:preview");
    expect(scope.group()).toBe("editor:projection:");
    scope.restart(scope.task("preview", sequence<unknown, string>([sleep(1), dispatch("ready")])));

    expect(insere.keys()).toEqual(["editor:projection:preview"]);
    expect(scope.cancelGroup(scope.group())).toBe(1);
    insere.tick(1);
    expect(events).toEqual([]);
  });

  it("spawns and restarts effects directly through a scoped key", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });
    const scope = new InsereTaskScope(insere).child("editor");

    scope.spawnEffect("drag", sequence<unknown, string>([sleep(10), dispatch("old")]));
    expect(scope.has("drag")).toBe(true);
    scope.restartEffect("drag", sequence<unknown, string>([sleep(1), dispatch("new")]));

    insere.tick(1);
    expect(events).toEqual(["new"]);
    expect(scope.has("drag")).toBe(false);
  });

  it("applies task policy through a scope", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });
    const scope = new InsereTaskScope(insere).child("editor");

    expect(scope.applyEffect(
      "projection",
      sequence<unknown, string>([sleep(10), dispatch("old")]),
      "skip"
    )).toBe(true);
    expect(scope.applyEffect(
      "projection",
      sequence<unknown, string>([sleep(1), dispatch("new")]),
      "skip"
    )).toBe(false);

    insere.tick(10);
    expect(events).toEqual(["old"]);
  });

  it("returns scoped Result reports for task policy application", () => {
    const insere = new Insere();
    const scope = new InsereTaskScope(insere).child("editor");

    expect(scope.applyEffectResult("projection", sleep(10), "skip")).toEqual(
      ok({
        key: "editor:projection",
        policy: "skip",
        applied: true,
        status: "started"
      })
    );
    expect(scope.applyEffectResult("projection", sleep(1), "skip")).toEqual(
      ok({
        key: "editor:projection",
        policy: "skip",
        applied: false,
        status: "skipped"
      })
    );
  });

  it("cancels scoped keys without repeating the prefix", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });
    const scope = new InsereTaskScope(insere).child("editor");

    scope.restartEffect("projection", sequence<unknown, string>([sleep(1), dispatch("ready")]));

    expect(scope.cancelKey("projection")).toBe(true);
    insere.tick(1);
    expect(events).toEqual([]);
  });

  it("cancels nested scoped groups without repeating the prefix", () => {
    const events: string[] = [];
    const insere = new Insere<unknown, string>({
      dispatch: (event) => events.push(event)
    });
    const scope = new InsereTaskScope(insere).child("editor");

    scope.restartEffect(
      ["projection", "primary"],
      sequence<unknown, string>([sleep(1), dispatch("primary")])
    );
    scope.restartEffect(
      ["projection", "preview"],
      sequence<unknown, string>([sleep(1), dispatch("preview")])
    );

    expect(scope.cancelScope("projection")).toBe(2);
    insere.tick(1);
    expect(events).toEqual([]);
  });

  it("lists keys inside a task scope", () => {
    const insere = new Insere();
    const scope = new InsereTaskScope(insere).child("editor");

    scope.restartEffect(["projection", "primary"], sleep(10));
    scope.restartEffect(["projection", "preview"], sleep(10));
    insere.restart("outside", toRoutine(sleep(10)));

    expect(scope.keys()).toEqual([
      "editor:projection:primary",
      "editor:projection:preview"
    ]);
    expect(scope.keys("projection")).toEqual([
      "editor:projection:primary",
      "editor:projection:preview"
    ]);
  });

  it("returns a filtered task scope snapshot", () => {
    const insere = new Insere();
    const scope = new InsereTaskScope(insere).child("editor");

    scope.restartEffect(["projection", "primary"], sleep(10));
    scope.restartEffect(["projection", "preview"], waitIdle());
    insere.restart("outside", toRoutine(sleep(10)));

    expect(scope.snapshot("projection")).toEqual({
      frame: 0,
      now: 0,
      delta: 0,
      size: 2,
      entries: [
        { key: "editor:projection:primary", wait: "delay" },
        { key: "editor:projection:preview", wait: "idle" }
      ]
    });
  });
});
