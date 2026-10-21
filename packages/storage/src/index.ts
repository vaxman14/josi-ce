export {
  PathEscape, displaySegments, extensionOf, isInside, resolveWithin, safeRelativePath,
  type ResolvedPath,
} from './paths.js';
export {
  MappingError, ROOT_BASE, capabilityFor, consentText, createMapping, mappingsBlockingUserRemoval,
  pauseMapping, purgeDerived, registerRoot, requireOwnedMapping, setIndexing, setPermissions, unmapFolder,
  type CreateMappingArgs, type Mapping, type Provider, type PurgeCounts, type StorageCapability,
} from './mappings.js';
export {
  ScannerUnavailable, checkFile, extractArchive, isArchive, limitsFrom, looksEncrypted,
  scanDocument, scanRequired, sha256, withinHours,
  type ArchiveEntry, type ArchiveLimits, type ArchiveOutcome, type ArchiveStop,
  type Candidate, type Ceilings, type GateResult, type ScanResult, type Scanner,
  type SkipReason, type StoragePolicy, type UsageNow,
} from './gates.js';
export {
  SKIP_EXPLANATIONS, ScanBlocked, ceilingsFor, ingestFile, mappingStatus,
  storagePolicy, usageFor,
  type IngestDeps, type IngestOutcome,
} from './ingest.js';
export {
  IMAGE_EXTENSIONS, IMAGE_MEDIA_TYPES,
  MAX_EXTRACT_CHARS, extractSegments, extractRichSegments, isExtractableExtension,
  looksLikeCredentialFile, skipDocument, storeExtraction,
  type ExtractedSegment,
} from './extract.js';
export {
  AUDIO_EXTENSIONS, MAX_MEDIA_SECONDS, MEDIA_PROCESSING, MEDIA_TRANSCRIPT, MediaUnavailable, PCM_RATE, TRANSCRIBE_CHUNK_SECONDS,
  VIDEO_EXTENSIONS, clock, extractFrames, extractPcm, isAudio, isVideo, mediaDuration, mediaToolsAvailable, transcriptText, withMediaFile,
  type TranscriptSegment, type VideoFrame,
} from './media.js';
export {
  ChatImageError, MAX_CHAT_IMAGE_BYTES, isHeic, normalizeChatImage,
  type NormalizedChatImage,
} from './chatImages.js';
export {
  SEMANTIC_DISCLOSURE, SemanticForbidden, SemanticNotConsented,
  assertSemanticAllowed, citationLabel, cosine, decodeVector, encodeVector,
  recordSemanticConsent, resolveCitations, revokeSemanticConsent, searchDocuments,
  type ResolvedCitation, type SearchHit,
} from './search.js';
export {
  blockedReason, claimNext, concurrencyFor, enqueue, finishJob, queueHealth,
  queuePolicy, setGlobalPause,
  type JobErrorCategory, type JobKind, type JobState, type QueuePolicy,
} from './queue.js';
export {
  HISTORY_LIMIT, MANUAL_SYNC_MIN_SECONDS, RETENTION_DAYS, SharingDisabled, SyncRefused,
  assertSharingAllowed, folderSyncHealthFor, historyDisclosure, mayManualSync, recordSyncFailure, recordVersion,
  retentionNotice as auditRetentionNotice, runAuditRetention, runRecycleBin, sharingPolicy,
  sourceDeleted, syncHealth, versionsToUnlink,
  type AuditRetention, type FolderSyncHealth, type HistoryKind, type HistoryMode, type HistoryPolicy,
  type SharingPolicy, type SyncPolicy,
} from './versions.js';
export { workspacePath, withWorkspaceDirectory, workspaceGrant, workspaceList, workspaceRead, workspaceChange, type WorkspaceChange } from './localWorkspace.js';
export { nativeWorkspaceProbe } from './nativeWorkspace.js';
export {
  WORKSPACE_MOUNT_PATH, linuxWorkspaceMountProbe, reconcileWorkspaceMount,
  workspaceMountConfiguration, workspaceMountRootAllowed, refreshNativeWorkspace, connectNativeWorkspace,
  type NativeWorkspaceStatus,
  type WorkspaceMountConfiguration, type WorkspaceMountProbe, type WorkspaceMountReconcileResult,
} from './workspaceMount.js';
export { ATTACHMENT_CAPABILITIES, attachmentLimit, maxAttachmentLimit,
  type AttachmentAnalysis, type AttachmentCapability, type AttachmentCategory,
} from './attachmentContract.js';
export { AttachmentError, attachmentFailure, attachmentRoot, validateAttachment,
  writeAttachment, writeAttachmentFromFile, readAttachment, removeAttachment, probeAttachmentStorage, cleanupAttachments,
  CHAT_FILE_BYTES, CHAT_USER_BYTES, CHAT_USER_FILES, CHAT_THREAD_FILES, CHAT_TENANT_BYTES,
} from './chatAttachments.js';
export { proposeCodingRun, getCodingRun, startCodingRun, codingRunStatus } from './workspaceCoding.js';
export { nativeScanner, NativeScanFailure, type NativeScannerOptions, type NativeScanStatus } from './nativeScanner.js';
export { nativeScannerHealth, type NativeScannerHealth } from './nativeScannerHealth.js';
export { openStorageFile, pinWindowsDirectory, publishWindowsFile } from './windowsFiles.js';

export { nativeMac } from './nativeRuntime.js';
