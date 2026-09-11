export class AgentIngressQueue {
  private tail: Promise<void> = Promise.resolve();
  private active = 0;
  private queued = 0;

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queued;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.queued += 1;
    const predecessor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await predecessor;
    this.queued -= 1;
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      release();
    }
  }
}
