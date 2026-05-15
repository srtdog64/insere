export interface InsereBaseContext<TState = unknown, TEvent = unknown> {
  readonly key: string;
  readonly frame: number;
  readonly now: number;
  readonly delta: number;
  dispatch(event: TEvent): void;
  getState(): TState;
}

export interface InsereCancellationContext {
  readonly signal: AbortSignal;
  onCancel(cleanup: () => void): () => void;
  throwIfCancelled(): void;
}
