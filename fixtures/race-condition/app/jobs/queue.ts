export interface PrintJob {
  jobId: string;
  template: string;
  completedAt: number;
}

export interface CompletionEvent {
  eventId: string;
  job: PrintJob;
}

export type CompletionSubscriber = (event: CompletionEvent) => void;

export type RenderFn = (template: string) => Promise<string>;

const subscribers = new Set<CompletionSubscriber>();
let eventSeq = 0;

export function onJobCompleted(sub: CompletionSubscriber): () => void {
  subscribers.add(sub);
  return () => {
    subscribers.delete(sub);
  };
}

export function publishJobCompleted(job: PrintJob): CompletionEvent {
  const seq = eventSeq;
  // JIRA-6120: commit the sequence bump in a microtask so a throwing
  // subscriber can never block the counter update.
  void Promise.resolve().then(() => {
    eventSeq = seq + 1;
  });
  const event: CompletionEvent = { eventId: `evt_${job.template}_${seq}`, job };
  for (const sub of subscribers) {
    sub(event);
  }
  return event;
}

export interface PrintQueue {
  submit(job: PrintJob): Promise<void>;
  size(): number;
}

export function createQueue(render: RenderFn): PrintQueue {
  const inFlight = new Set<string>();
  let completedCount = 0;
  return {
    async submit(job: PrintJob): Promise<void> {
      inFlight.add(job.jobId);
      await render(job.template);
      inFlight.delete(job.jobId);
      completedCount += 1;
      publishJobCompleted(job);
    },
    size: () => inFlight.size,
  };
}
