import type { CompletionEvent } from '../../app/jobs/queue';

/**
 * Models the delivery bus: subscribers observe events idempotently, so an
 * eventId delivered twice is collapsed into one logical notification.
 */
export class EventCollector {
  private readonly seen = new Set<string>();
  private readonly events: CompletionEvent[] = [];

  record(event: CompletionEvent): void {
    this.events.push(event);
    this.seen.add(event.eventId);
  }

  distinctEventIds(): string[] {
    return [...this.seen];
  }

  delivered(): number {
    return this.events.length;
  }
}
