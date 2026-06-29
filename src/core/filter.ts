import path from "node:path";
import { minimatch } from "minimatch";
import { ScanConfig } from "../types.js";
import { isLikelyOneDrivePath } from "../utils/paths.js";

export const defaultExcludedFolders = new Set([
  "node_modules",
  ".git",
  "$recycle.bin",
  "thumbcache",
  "cache",
]);

export const shouldSkipDirectory = (
  dirPath: string,
  cfg: ScanConfig,
  depth: number,
): string | null => {
  const lower = dirPath.toLowerCase();
  const folderName = path.basename(lower);

  if (depth > 0 && defaultExcludedFolders.has(folderName)) {
    return "default_cache_rule";
  }

  if (cfg.excludePaths?.some((x) => lower.includes(x.toLowerCase()))) {
    return "user_exclude_path";
  }

  if (cfg.excludeGlobs?.some((g) => minimatch(dirPath, g, { nocase: true }))) {
    return "exclude_glob";
  }

  return null;
};

export const shouldSkipFileByRules = (
  filePath: string,
  size: number,
  cfg: ScanConfig,
): string | null => {
  if (cfg.minSizeBytes !== undefined && size < cfg.minSizeBytes) {
    return "below_min_size";
  }
  if (cfg.maxSizeBytes !== undefined && size > cfg.maxSizeBytes) {
    return "above_max_size";
  }

  const lower = filePath.toLowerCase();
  if (cfg.excludePaths?.some((x) => lower.includes(x.toLowerCase()))) {
    return "user_exclude_path";
  }

  if (cfg.excludeGlobs?.some((g) => minimatch(filePath, g, { nocase: true }))) {
    return "exclude_glob";
  }

  if (
    cfg.includeGlobs &&
    cfg.includeGlobs.length > 0 &&
    !cfg.includeGlobs.some((g) => minimatch(filePath, g, { nocase: true }))
  ) {
    return "not_in_include_glob";
  }

  return null;
};

export const shouldSkipOneDrivePlaceholder = (
  filePath: string,
  size: number,
  cfg: ScanConfig,
): string | null => {
  if (!cfg.skipOneDrivePlaceholders) {
    return null;
  }

  if (!isLikelyOneDrivePath(filePath)) {
    return null;
  }

  if (size === 0) {
    return "onedrive_placeholder";
  }

  return null;
};
