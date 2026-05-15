export interface InsereClockSnapshot {
  readonly frame: number;
  readonly now: number;
  readonly delta: number;
}

export class InsereClock {
  #frame = 0;
  #now = 0;
  #previousNow = 0;
  #delta = 0;

  get frame(): number {
    return this.#frame;
  }

  get now(): number {
    return this.#now;
  }

  get delta(): number {
    return this.#delta;
  }

  advance(now: number): void {
    if (!Number.isFinite(now)) {
      throw new RangeError(`Invalid tick time: ${now}`);
    }

    this.#delta = this.#frame === 0 ? 0 : now - this.#previousNow;
    this.#previousNow = now;
    this.#now = now;
    this.#frame += 1;
  }

  snapshot(): InsereClockSnapshot {
    return {
      frame: this.#frame,
      now: this.#now,
      delta: this.#delta
    };
  }
}
