export {
  PathEscape, displaySegments, extensionOf, isInside, resolveWithin, safeRelativePath,
  type ResolvedPath,
} from './paths.js';
export {
  MappingError, ROOT_BASE, capabilityFor, consentText, createMapping, mappingsBlockingUserRemoval,
  pauseMapping, purgeDerived, registerRoot, requireOwnedMapping, setIndexing, setPermissions, unmapFolder,
  type CreateMappingArgs, type Mapping, type Provider, type PurgeCounts, type StorageCapability,
} from './mappings.js';
