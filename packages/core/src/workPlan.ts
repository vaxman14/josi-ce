/** A dependency is about work order, never permission to dispatch an effect. */
export interface WorkGoalStep {
  id: string;
  title: string;
  state: 'pending' | 'working' | 'blocked' | 'verified' | 'skipped';
  taskId: string | null;
  evidence: string | null;
  dependsOn?: string[];
  blockedReason?: string | null;
  blockedUntil?: string | null;
  /** Only an explicit owner control can create this retained retirement. */
  retirement?: { actorUserId: string; reason: string; at: string; outcomeRevision: number; planRevision: number };
  /** A step done many times over ("describe photos 1 to 53"): the server
   * counts each successful run of `tool` as one item, keeps `done` current
   * from the receipts, and verifies the step itself when the count is
   * reached. No model-written checkpoint per item (build item 38). */
  repeat?: { count: number; unit: string; tool: string; done: number } | null;
}
export function workStepProgress(step: WorkGoalStep): string | null {
  if (!step.repeat) return null;
  const unit = step.repeat.unit.trim() || 'item';
  return `${unit.charAt(0).toUpperCase()}${unit.slice(1)} ${Math.min(step.repeat.done, step.repeat.count)} of ${step.repeat.count}`;
}
export function workStepRequired(step: WorkGoalStep): boolean { return step.state !== 'skipped'; }
export function workStepUnfinished(step: WorkGoalStep): boolean { return workStepRequired(step) && step.state !== 'verified'; }
export function workDependencies(steps: WorkGoalStep[], step: WorkGoalStep): string[] {
  if (Array.isArray(step.dependsOn)) return step.dependsOn;
  // An older checklist is sequential until the plan explicitly says otherwise.
  const index = steps.findIndex(value => value.id === step.id);
  return index > 0 ? [steps[index - 1].id] : [];
}
export function workDependenciesSatisfied(steps: WorkGoalStep[], step: WorkGoalStep): boolean {
  return workDependencies(steps, step).every(id => steps.some(value => value.id === id && value.state === 'verified'));
}
export function readyWorkSteps(steps: WorkGoalStep[], unavailable: ReadonlySet<string> = new Set()): WorkGoalStep[] {
  return steps.filter(step => workStepUnfinished(step) && step.state !== 'blocked'
    && !unavailable.has(step.id) && workDependenciesSatisfied(steps, step));
}
