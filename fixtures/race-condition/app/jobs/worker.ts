/**
 * Label rendering workers. Rendering is I/O shaped (rasterize template,
 * spool to the print daemon), so durations vary slightly per template —
 * which is exactly why completions can land in the same tick under load.
 */
export function renderTemplate(template: string): Promise<string> {
  return new Promise((resolve) => {
    const ms = 3 + (template.length % 5);
    setTimeout(() => resolve(`${template} rendered in ${ms}ms`), ms);
  });
}

export interface WorkerPoolStats {
  renders: number;
  lastTemplate: string | null;
}

export function createWorkerStats(): WorkerPoolStats {
  return { renders: 0, lastTemplate: null };
}

export function recordRender(stats: WorkerPoolStats, template: string): void {
  stats.renders += 1;
  stats.lastTemplate = template;
}
