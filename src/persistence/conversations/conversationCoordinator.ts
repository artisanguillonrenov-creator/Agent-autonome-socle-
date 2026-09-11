export class ConversationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private exclusiveBarrier: Promise<void> = Promise.resolve();
  private exclusivePending = 0;

  isQueuedOrActive(conversationId: string): boolean {
    return this.tails.has(conversationId);
  }

  get hasExclusiveWork(): boolean {
    return this.exclusivePending > 0;
  }

  execute<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    const predecessor = this.tails.get(conversationId) ?? Promise.resolve();
    const barrier = this.exclusiveBarrier;
    const work = Promise.all([predecessor, barrier]).then(() => task());
    const tail = work.then(() => undefined, () => undefined);
    this.tails.set(conversationId, tail);
    void tail.finally(() => {
      if (this.tails.get(conversationId) === tail) this.tails.delete(conversationId);
    });
    return work;
  }

  executeExclusive<T>(task: () => Promise<T>): Promise<T> {
    const predecessorBarrier = this.exclusiveBarrier;
    const existingConversationTails = Array.from(this.tails.values());
    this.exclusivePending += 1;

    const work = Promise.all([predecessorBarrier, ...existingConversationTails]).then(() => task());
    const barrier = work.then(() => undefined, () => undefined);
    this.exclusiveBarrier = barrier;
    void barrier.finally(() => {
      this.exclusivePending = Math.max(0, this.exclusivePending - 1);
    });
    return work;
  }
}
