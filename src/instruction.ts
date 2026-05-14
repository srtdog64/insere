export type InsereInstruction<TResume = unknown> =
  | { readonly kind: "frame" }
  | { readonly kind: "idle" }
  | { readonly kind: "delay"; readonly ms: number }
  | { readonly kind: "promise"; readonly promise: Promise<TResume> };

const FRAME_INSTRUCTION: InsereInstruction = { kind: "frame" };
const IDLE_INSTRUCTION: InsereInstruction = { kind: "idle" };

export function frame(): InsereInstruction {
  return FRAME_INSTRUCTION;
}

export function idle(): InsereInstruction {
  return IDLE_INSTRUCTION;
}

export function delay(ms: number): InsereInstruction {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`Invalid delay: ${ms}`);
  }

  return { kind: "delay", ms };
}

export function fromPromise<TValue>(
  promise: Promise<TValue>
): InsereInstruction<TValue> {
  return { kind: "promise", promise };
}
