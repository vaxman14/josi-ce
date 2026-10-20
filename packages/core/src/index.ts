export * from './db.js';
export * from './pcControl.js';
export * from './connect.js';
// Phase 13 — the edition capability boundary. First in the list because it is
// the thing everything capability-gated has to consult.
export * from './edition.js';
export {
  BUILD_EDITION, BUILD_ID, BUILD_LICENCE_PUBLIC_KEY, BUILD_RELEASE_PUBLIC_KEY,
} from './buildStamp.js';
export * from './licence.js';
export * from './entitlements.js';
export * from './parental.js';
export * from './events.js';
export * from './masterKey.js';
export * from './readiness.js';
export * from './sealing.js';
export * from './vault.js';
export * from './cardinalRules.js';
export * from './automationPermissions.js';
export { AUTOMATION_ENFORCEMENT_VERSION, automationPolicyChangeBinding,
  type AutomationPolicyDocument, type AutomationPolicyView, type AutomationPolicyCommand, type AutomationPolicyAuthority, type AutomationPolicyDecision,
  type AutomationPolicyReplacement, type AutomationPolicyProtectedReview } from './automationPolicy.js';
export type { VaultAutomationPreview } from './vaultRecords.js';
export { ProtectedConfirmationError, type ProtectedConfirmationAuthority, type ProtectedConfirmationCommand,
  type ProtectedConfirmationIdentity } from './protectedConfirmations.js';
export { protectedDeviceEnrollmentMessage, type ProtectedDeviceAuthority, type ProtectedDeviceCommand,
  type ProtectedDeviceEnrollment, type ProtectedDeviceRevocation, type ProtectedDeviceInventory,
  type ProtectedDeviceSummary, type NativeVaultSigningMaterial } from './protectedDevices.js';
export { AutomationReservationError, type AutomationReservationRequest, type AutomationReservationView, type AutomationReservationState,
  type AutomationReservationProofPort } from './automationReservations.js';
export * from './cardinalDrafts.js';
export { CARDINAL_ENFORCEMENT_VERSION, cardinalActivationBinding, cardinalRetirementBinding,
  type CardinalActiveRule, type CardinalPolicyDocument, type CardinalPolicyView, type CardinalPolicyCommand, type CardinalPolicyAuthority, type CardinalPolicyDecision,
  type CardinalProtectedReview, type CardinalActivationRequest, type CardinalRetirementRequest } from './cardinalPolicy.js';
export * from './workspace.js';
export * from './setupVerification.js';
export * from './launchChecklist.js';
export * from './contactIdentity.js';
export * from './ownership.js';
// Phase 5 — the assistant's domain logic.
export * from './tasks.js';
export * from './workGoals.js';
export * from './workMemoryContext.js';
export * from './automationRuntime.js';
export { type WorkspaceStorageAuthority, type WorkspaceStorageSummary } from './workspaceStorage.js';
export * from './workContinuation.js';
export * from './conversations.js';
export * from './approvals.js';
export * from './actionState.js';
export * from './stepUp.js';
export * from './locks.js';
export * from './queue.js';
export * from './reminders.js';
export * from './metrics.js';
export * from './mobile.js';
export {
  LIMITS, consume, peek, pruneRateLimits, type Limit, type LimitVerdict,
} from './ratelimit.js';
export { privateTemporaryDirectory } from './privateTemporaryDirectory.js';
export { resolveDataPath } from './dataPath.js';
export { apiListenHost } from './nativeNetwork.js';
export { readWindowsSecret } from './windowsSecrets.js';
export { readMacSecret } from './macosSecrets.js';
export { inspectCredentialMigration, migrateStoredCredentials, type CredentialMigrationCount, type CredentialMigrationReport } from './credentialMigration.js';

export { refuseMemorySecret } from './memorySafety.js';

export { type AutomationTargetRegistration, type AutomationApplicationTarget, type ApplicationCandidate } from './automationTargets.js';
export { listAutomationModelCandidates, type AutomationModelCandidate, type AutomationModelTarget } from './automationModelTargets.js';
