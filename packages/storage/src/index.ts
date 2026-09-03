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
  MAX_EXTRACT_CHARS, extractSegments, extractRichSegments, isExtractableExtension,
  looksLikeCredentialFile, skipDocument, storeExtraction,
  type ExtractedSegment,
} from './extract.js';
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
  assertSharingAllowed, historyDisclosure, mayManualSync, recordSyncFailure, recordVersion,
  retentionNotice as auditRetentionNotice, runAuditRetention, runRecycleBin, sharingPolicy,
  sourceDeleted, syncHealth, versionsToUnlink,
  type AuditRetention, type HistoryKind, type HistoryMode, type HistoryPolicy,
  type SharingPolicy, type SyncPolicy,
} from './versions.js';
