import {
  Insere,
  abortable,
  createBufferedInsereLogger,
  createInsereHostAdapter,
  createInsereEventBus,
  createInsereMailbox,
  currentDelta,
  frameLoopStep,
  dispatch,
  waitEvent
} from "../dist/index.js";
import {
  createInsereApi,
  createConsoleInsereLogger
} from "../dist/api.js";
import { createInsereHostAdapter as createHostFromSubpath } from "../dist/host.js";
import { createInsereEventBus as createEventBusFromSubpath } from "../dist/event-bus.js";
import { createInsereMailbox as createMailboxFromSubpath } from "../dist/mailbox.js";
import { normalizeInsereSupervision } from "../dist/supervision.js";

const events = [];
const logs = createBufferedInsereLogger();
const api = createInsereApi({
  dispatch: (event) => events.push(event),
  logger: logs.logger,
  supervision: {
    policy: "dispatchAndStop",
    toEvent: (failure) => `failed:${failure.key}`
  }
});

api.waitFrame("direct:preview", (ctx) => ctx.dispatch(`direct:${ctx.delta}`));
api.frameLoop("direct:loop", (ctx) => {
  ctx.dispatch(`loop:${ctx.frame}`);
  return false;
});
api.applyEffect("effect:delta", function* (ctx) {
  const delta = yield* currentDelta()(ctx);
  yield* dispatch(`effect:${delta}`)(ctx);
});
api.tick(16);
api.tick(32);

if (
  !events.includes("direct:0") ||
  !events.includes("loop:1") ||
  !events.includes("effect:0")
) {
  throw new Error(`Unexpected api events: ${JSON.stringify(events)}`);
}

if (typeof frameLoopStep(() => false) !== "function") {
  throw new Error("frameLoopStep export is not usable.");
}

api.waitFrame("broken", () => {
  throw new Error("boom");
});
api.tick(48);

if (!events.includes("failed:broken")) {
  throw new Error("Supervision dispatch did not run.");
}

const mailbox = createInsereMailbox({ buffer: "latest" });
mailbox.emit("ready");

if ((await mailbox.wait()) !== "ready") {
  throw new Error("Mailbox did not return buffered event.");
}

const consumeOne = createInsereMailbox();
const consumed = [];
const first = consumeOne.wait().then((event) => consumed.push(`first:${event}`));
const second = consumeOne.wait().then((event) => consumed.push(`second:${event}`));

if (consumeOne.emitOne("single") !== 1) {
  throw new Error("Mailbox emitOne did not consume one waiter.");
}

await first;

if (consumed.join(",") !== "first:single" || consumeOne.waiters !== 1) {
  throw new Error(`Mailbox emitOne consumed unexpected waiters: ${consumed}`);
}

consumeOne.emit("broadcast");
await second;

const eventBus = createInsereEventBus({ buffer: "latest" });
eventBus.emit("key", "ready");

if ((await eventBus.wait("key")) !== "ready") {
  throw new Error("Event bus did not return buffered event.");
}

const hostEvents = [];
const host = createInsereHostAdapter({
  dispatch: (event) => hostEvents.push(event)
});

host.api.applyEffect("input", function* (ctx) {
  const event = yield* waitEvent(host.mailbox, (item) => item === "commit")(ctx);
  yield* dispatch(event)(ctx);
});
host.emit("commit");
await Promise.resolve();
host.tick(1);

if (hostEvents[0] !== "commit") {
  throw new Error("Host adapter mailbox did not dispatch.");
}

const hostConsume = createInsereHostAdapter({
  dispatch: (event) => hostEvents.push(event)
});
hostConsume.api.applyEffect("first", function* (ctx) {
  const event = yield* hostConsume.waitEvent()(ctx);
  yield* dispatch(`first:${event}`)(ctx);
});
hostConsume.api.applyEffect("second", function* (ctx) {
  const event = yield* hostConsume.waitEvent()(ctx);
  yield* dispatch(`second:${event}`)(ctx);
});
hostConsume.emitOne("single");
await Promise.resolve();
hostConsume.tick(1);

if (!hostEvents.includes("first:single") || hostConsume.mailbox.waiters !== 1) {
  throw new Error("Host adapter emitOne did not consume exactly one waiter.");
}

let aborted = false;
const io = new Insere();
io.restart(
  "io",
  function* (ctx) {
    yield* abortable((signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => undefined);
    })(ctx);
  }
);
io.cancel("io");

if (!aborted) {
  throw new Error("AbortSignal bridge did not abort.");
}

if (
  typeof createConsoleInsereLogger() !== "function" ||
  typeof createHostFromSubpath() !== "object" ||
  typeof createEventBusFromSubpath() !== "object" ||
  typeof createMailboxFromSubpath() !== "object" ||
  normalizeInsereSupervision({ policy: "logAndStop" }).policy !== "logAndStop"
) {
  throw new Error("Subpath exports are not usable.");
}

console.log("smoke exports ok");
