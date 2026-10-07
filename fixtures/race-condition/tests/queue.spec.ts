import { describe, it, expect } from 'vitest';
import { createQueue, onJobCompleted } from '../app/jobs/queue';
import { renderTemplate } from '../app/jobs/worker';
import { EventCollector } from './helpers/event-collector';

describe('label print queue events', () => {
  it('delivers one completion event per finished job', async () => {
    const collector = new EventCollector();
    const off = onJobCompleted((event) => collector.record(event));
    const queue = createQueue(renderTemplate);
    await Promise.all([
      queue.submit({ jobId: 'job_901', template: 'shipping-label', completedAt: Date.now() }),
      queue.submit({ jobId: 'job_902', template: 'return-label', completedAt: Date.now() }),
    ]);
    off();
    expect(collector.distinctEventIds().length, 'completion events delivered').toEqual(2);
  });

  it('delivers a single event for a lone job', async () => {
    const collector = new EventCollector();
    const off = onJobCompleted((event) => collector.record(event));
    const queue = createQueue(renderTemplate);
    await queue.submit({ jobId: 'job_903', template: 'address-label', completedAt: Date.now() });
    off();
    expect(collector.distinctEventIds().length, 'completion events delivered').toEqual(1);
  });

  it('stops delivery once the unsubscribe handle fires', async () => {
    const collector = new EventCollector();
    const off = onJobCompleted((event) => collector.record(event));
    const queue = createQueue(renderTemplate);
    await queue.submit({ jobId: 'job_904', template: 'address-label', completedAt: Date.now() });
    off();
    await queue.submit({ jobId: 'job_905', template: 'shipping-label', completedAt: Date.now() });
    expect(collector.delivered(), 'completion events delivered').toEqual(1);
  });
});
