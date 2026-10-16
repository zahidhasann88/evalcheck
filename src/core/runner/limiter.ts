export interface Sleep {
  (ms: number): Promise<void>;
}

export const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const effective = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const runners = Array.from({ length: effective }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** Spaces requests at least `1000 / rps` ms apart across all workers. */
export class RateLimiter {
  private nextSlot = 0;

  constructor(
    private readonly rps: number,
    private readonly sleep: Sleep = defaultSleep,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get minIntervalMs(): number {
    return this.rps > 0 ? 1000 / this.rps : 0;
  }

  async acquire(): Promise<void> {
    if (this.rps <= 0) return;
    const current = this.now();
    const slot = Math.max(current, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    const wait = slot - current;
    if (wait > 0) await this.sleep(wait);
  }
}
