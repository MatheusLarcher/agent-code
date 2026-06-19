/**
 * A minimal push-based async iterable. The Agent SDK consumes user messages via
 * an AsyncIterable; we push onto this queue whenever the user sends a message,
 * and the SDK pulls them as it is ready.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private resolvers: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve({ value, done: false })
    else this.values.push(value)
  }

  close(): void {
    this.closed = true
    let resolve = this.resolvers.shift()
    while (resolve) {
      resolve({ value: undefined as never, done: true })
      resolve = this.resolvers.shift()
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift() as T, done: false })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true })
        }
        return new Promise((resolve) => this.resolvers.push(resolve))
      }
    }
  }
}
