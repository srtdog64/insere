export const INSERE_INSTRUCTION_FRAME = 0;
export const INSERE_INSTRUCTION_IDLE = 1;
export const INSERE_INSTRUCTION_DELAY = 2;
export const INSERE_INSTRUCTION_PROMISE = 3;

export type InsereInstruction<TResume = unknown> =
  | { readonly kind: "frame"; readonly op?: typeof INSERE_INSTRUCTION_FRAME }
  | { readonly kind: "idle"; readonly op?: typeof INSERE_INSTRUCTION_IDLE }
  | {
      readonly kind: "delay";
      readonly op?: typeof INSERE_INSTRUCTION_DELAY;
      readonly ms: number;
    }
  | {
      readonly kind: "promise";
      readonly op?: typeof INSERE_INSTRUCTION_PROMISE;
      readonly promise: Promise<TResume>;
    };

const FRAME_INSTRUCTION: InsereInstruction = {
  kind: "frame",
  op: INSERE_INSTRUCTION_FRAME
};
const IDLE_INSTRUCTION: InsereInstruction = {
  kind: "idle",
  op: INSERE_INSTRUCTION_IDLE
};

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

  return { kind: "delay", op: INSERE_INSTRUCTION_DELAY, ms };
}

export function fromPromise<TValue>(
  promise: Promise<TValue>
): InsereInstruction<TValue> {
  return { kind: "promise", op: INSERE_INSTRUCTION_PROMISE, promise };
}
