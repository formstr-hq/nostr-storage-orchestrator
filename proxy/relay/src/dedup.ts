export class BoundedEventDedup {
  private readonly maxSize: number;
  private readonly order: string[] = [];
  private readonly seen = new Set<string>();

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  add(eventId: string): boolean {
    if (this.seen.has(eventId)) {
      return false;
    }
    this.seen.add(eventId);
    this.order.push(eventId);
    while (this.order.length > this.maxSize) {
      const oldest = this.order.shift();
      if (oldest) {
        this.seen.delete(oldest);
      }
    }
    return true;
  }

  clear(): void {
    this.order.length = 0;
    this.seen.clear();
  }
}
