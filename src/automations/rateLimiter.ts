/** Limitation simple par fenêtre fixe — protège les endpoints webhook (automations.externalEventTriggers) contre les abus. */
export class FixedWindowRateLimiter {
  private windowStart = Date.now();
  private count = 0;

  constructor(private readonly max: number, private readonly windowMs: number) {}

  allow(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.max;
  }
}
