/** IDs are opaque server identifiers. Owner fields are assigned from an
 * authenticated session, never trusted from a client request. */
export interface WorkOwner { userId: string; serverId: string }
export type GoalState = 'accepted' | 'planning' | 'working' | 'waiting' | 'needs_instruction' | 'paused' | 'verifying' | 'completed' | 'cancelled';
export type AttemptState = 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';
export interface EvidenceReference { id: string; kind: 'receipt' | 'artifact' | 'observation' | 'verification' }
export type Continuation =
  | { kind: 'action'; stepId: string }
  | { kind: 'wait'; reason: string; wakeAt: string }
  | { kind: 'question'; questionId: string; text: string }
  | { kind: 'user_paused' };
export interface GoalRecord extends WorkOwner {
  id: string;
  threadId: string;
  revision: number;
  outcome: string;
  completionCriteria: string[];
  state: GoalState;
  continuation: Continuation | null;
  evidence: EvidenceReference[];
  createdAt: string;
  updatedAt: string;
}
export interface GoalStep {
  id: string;
  goalId: string;
  planRevision: number;
  title: string;
  dependsOn: string[];
  state: 'pending' | 'working' | 'blocked' | 'verified' | 'skipped';
  evidence: EvidenceReference[];
}
export interface WorkAttempt {
  id: string;
  goalId: string;
  stepId: string;
  state: AttemptState;
  /** Links to existing fenced jobs/durable effects; no new duplicate retry path. */
  jobId: string | null;
  effectKey: string | null;
  startedAt: string | null;
  endedAt: string | null;
  evidence: EvidenceReference[];
}
export type WorkEventKind = 'goal.accepted' | 'plan.changed' | 'step.started' | 'step.verified'
  | 'attempt.failed' | 'effect.uncertain' | 'goal.waiting' | 'instruction.requested'
  | 'goal.paused' | 'goal.resumed' | 'goal.completed' | 'goal.cancelled' | 'memory.checkpoint';
export interface WorkEvent extends WorkOwner {
  id: string;
  goalId: string;
  /** Monotonic within a goal. Clients deduplicate and resume after this cursor. */
  sequence: number;
  goalRevision: number;
  kind: WorkEventKind;
  summary: string;
  evidence: EvidenceReference[];
  occurredAt: string;
}
/** Both chat and Tasks consume this projection. Attempts/replies are not steps. */
export interface GoalProgress {
  goalId: string;
  revision: number;
  afterSequence: number;
  state: GoalState;
  title: string;
  activity: string;
  verifiedSteps: number;
  totalSteps: number;
  continuation: Continuation | null;
}
