/** Goal-owner limits for background continuations. They cannot grant tool,
 * network, model-spending or Cardinal authority. Counts include queued and
 * interrupted runs and never reset on progress, steering or Resume. */
export interface WorkBudgetRow {
  automatic_run_limit?: number | null;
  automatic_runs_used?: number;
  automatic_deadline?: string | null;
}
export function workBudgetReason(row: WorkBudgetRow, now = Date.now()): string | null {
  if (row.automatic_deadline && Date.parse(row.automatic_deadline) <= now) {
    return 'The background-work deadline has passed. Extend the deadline in Work limits and resume with instructions, or cancel this goal.';
  }
  if (row.automatic_run_limit != null && (row.automatic_runs_used ?? 0) >= row.automatic_run_limit) {
    return `Josi reached your limit of ${row.automatic_run_limit} background runs. Increase the total in Work limits and resume with instructions, or cancel this goal.`;
  }
  return null;
}
