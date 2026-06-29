import { FileAnalysisCacheEntry } from "../types.js";

interface CacheIdentity {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

const toBaseEntry = (identity: CacheIdentity): FileAnalysisCacheEntry => ({
  ...identity,
  quickHash: null,
  quickHashBytes: null,
  fullHash: null,
  riskDescriptors: [],
  updatedAt: new Date().toISOString(),
});

export const isCacheEntryCurrent = (
  entry: FileAnalysisCacheEntry,
  identity: CacheIdentity,
): boolean => (
  entry.path === identity.path
  && entry.size === identity.size
  && entry.mtimeMs === identity.mtimeMs
  && entry.ctimeMs === identity.ctimeMs
);

export const getCurrentCacheEntry = (
  cache: Map<string, FileAnalysisCacheEntry> | undefined,
  identity: CacheIdentity,
): FileAnalysisCacheEntry | null => {
  if (!cache) {
    return null;
  }

  const entry = cache.get(identity.path);
  if (!entry || !isCacheEntryCurrent(entry, identity)) {
    return null;
  }

  return entry;
};

export const upsertCacheEntry = (
  cache: Map<string, FileAnalysisCacheEntry> | undefined,
  identity: CacheIdentity,
  patch: Partial<FileAnalysisCacheEntry>,
): FileAnalysisCacheEntry | null => {
  if (!cache) {
    return null;
  }

  const existing = getCurrentCacheEntry(cache, identity);
  const next: FileAnalysisCacheEntry = {
    ...(existing ?? toBaseEntry(identity)),
    ...patch,
    path: identity.path,
    size: identity.size,
    mtimeMs: identity.mtimeMs,
    ctimeMs: identity.ctimeMs,
    riskDescriptors: patch.riskDescriptors ?? existing?.riskDescriptors ?? [],
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  };

  cache.set(identity.path, next);
  return next;
};
