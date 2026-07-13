/**
 * A push-driven async iterable used as the streaming-input prompt for the SDK
 * `query()`. Producers `push()` user turns; the consumer (`for await`) receives
 * them in order and blocks until more arrive or `end()` is called.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    while (this.waiters.length) {
      this.waiters.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
