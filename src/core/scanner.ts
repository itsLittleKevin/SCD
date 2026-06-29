import fs from "node:fs/promises";
import { Dirent } from "node:fs";
import path from "node:path";
import { FileAnalysisCacheEntry, RiskFlag, ScanConfig, ScanEvent, ScanStats } from "../types.js";
import { newId, stableId } from "../utils/ids.js";
import { normalizePath } from "../utils/paths.js";
import {
  shouldSkipDirectory,
  shouldSkipFileByRules,
  shouldSkipOneDrivePlaceholder,
} from "./filter.js";
import { getCurrentCacheEntry, upsertCacheEntry } from "./analysisCache.js";
import { analyzeRisks } from "./risk.js";

interface WalkItem {
  path: string;
  depth: number;
}

interface ScanFilesOptions {
  analysisCache?: Map<string, FileAnalysisCacheEntry>;
}

interface FileProcessingResult {
  events: ScanEvent[];
  filesVisited: number;
  filesIndexed: number;
  filesSkipped: number;
  risks: number;
}

interface SettledFileTask {
  tracked: Promise<SettledFileTask>;
  result: FileProcessingResult;
}

const inferFsType = (p: string): string => {
  if (process.platform === "win32" && /^[a-zA-Z]:/.test(p)) {
    return "ntfs_like";
  }
  return "posix_like";
};

const toCachedRiskFlags = (
  taskId: string,
  filePath: string,
  cached: FileAnalysisCacheEntry["riskDescriptors"],
): RiskFlag[] => cached.map((risk) => ({
  id: newId(),
  taskId,
  filePath,
  kind: risk.kind,
  detail: risk.detail,
  stage: risk.stage,
  createdAt: new Date().toISOString(),
}));

const processFileCandidate = async (
  taskId: string,
  cfg: ScanConfig,
  fullPath: string,
  analysisCache?: Map<string, FileAnalysisCacheEntry>,
): Promise<FileProcessingResult> => {
  const baseResult: FileProcessingResult = {
    events: [],
    filesVisited: 1,
    filesIndexed: 0,
    filesSkipped: 0,
    risks: 0,
  };

  let st;
  try {
    st = await fs.stat(fullPath, { bigint: false });
  } catch (error) {
    return {
      ...baseResult,
      risks: 1,
      events: [
        {
          type: "risk_flag",
          risk: {
            id: newId(),
            taskId,
            filePath: fullPath,
            kind: "io_error",
            detail: (error as Error).message,
            stage: "stat",
            createdAt: new Date().toISOString(),
          },
        },
      ],
    };
  }

  const events: ScanEvent[] = [{ type: "file_seen", path: fullPath, size: st.size }];
  const skipReason = shouldSkipFileByRules(fullPath, st.size, cfg);
  if (skipReason) {
    events.push({ type: "file_skipped", path: fullPath, reason: skipReason });
    return {
      ...baseResult,
      filesSkipped: 1,
      events,
    };
  }

  const oneDriveReason = shouldSkipOneDrivePlaceholder(fullPath, st.size, cfg);
  if (oneDriveReason) {
    events.push({
      type: "risk_flag",
      risk: {
        id: newId(),
        taskId,
        filePath: fullPath,
        kind: "onedrive_offline",
        detail: oneDriveReason,
        stage: "filter",
        createdAt: new Date().toISOString(),
      },
    });
    events.push({ type: "file_skipped", path: fullPath, reason: oneDriveReason });
    return {
      ...baseResult,
      filesSkipped: 1,
      risks: 1,
      events,
    };
  }

  const cacheIdentity = {
    path: fullPath,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
  };

  let risks: RiskFlag[];
  const cachedEntry = getCurrentCacheEntry(analysisCache, cacheIdentity);
  if (cachedEntry) {
    risks = toCachedRiskFlags(taskId, fullPath, cachedEntry.riskDescriptors);
  } else {
    risks = await analyzeRisks(taskId, fullPath);
    upsertCacheEntry(analysisCache, cacheIdentity, {
      riskDescriptors: risks.map((risk) => ({
        kind: risk.kind,
        detail: risk.detail,
        stage: risk.stage,
      })),
    });
  }

  let skipDueToRisk = false;
  for (const risk of risks) {
    events.push({ type: "risk_flag", risk });
    if (risk.kind === "encrypted_archive" || risk.kind === "encrypted_pdf") {
      skipDueToRisk = true;
    }
  }

  if (skipDueToRisk) {
    events.push({ type: "file_skipped", path: fullPath, reason: "encrypted_content" });
    return {
      ...baseResult,
      filesSkipped: 1,
      risks: risks.length,
      events,
    };
  }

  const record = {
    id: stableId(`${taskId}:${fullPath}`),
    taskId,
    path: fullPath,
    parentPath: path.dirname(fullPath),
    name: path.basename(fullPath),
    ext: path.extname(fullPath).toLowerCase(),
    size: st.size,
    ctimeMs: st.ctimeMs,
    mtimeMs: st.mtimeMs,
    atimeMs: st.atimeMs,
    fsType: inferFsType(fullPath),
    platform: process.platform,
    isDir: false,
    scanStatus: "indexed" as const,
  };
  events.push({ type: "file_indexed", record });
  return {
    ...baseResult,
    filesIndexed: 1,
    risks: risks.length,
    events,
  };
};

export async function* scanFiles(
  taskId: string,
  cfg: ScanConfig,
  opts: ScanFilesOptions = {},
): AsyncGenerator<ScanEvent> {
  const stats: ScanStats = {
    dirsVisited: 0,
    filesVisited: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    risks: 0,
  };

  yield { type: "scan_started", taskId, roots: cfg.roots };

  const queue: WalkItem[] = cfg.roots.map((root) => ({ path: normalizePath(root), depth: 0 }));
  const fileConcurrency = Math.max(1, Math.min(64, Math.trunc(cfg.ioConcurrency ?? 16)));
  const pendingFiles = new Set<Promise<SettledFileTask>>();

  const pushFileTask = (filePath: string): void => {
    const resultPromise = processFileCandidate(taskId, cfg, filePath, opts.analysisCache)
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        const fallback: FileProcessingResult = {
          events: [
            {
              type: "risk_flag",
              risk: {
                id: newId(),
                taskId,
                filePath,
                kind: "io_error",
                detail,
                stage: "scan",
                createdAt: new Date().toISOString(),
              },
            },
          ],
          filesVisited: 1,
          filesIndexed: 0,
          filesSkipped: 0,
          risks: 1,
        };
        return fallback;
      });

    let tracked: Promise<SettledFileTask>;
    tracked = resultPromise.then((result) => ({ tracked, result }));
    pendingFiles.add(tracked);
  };

  const applyFileResult = async function* (
    result: FileProcessingResult,
  ): AsyncGenerator<ScanEvent> {
    stats.filesVisited += result.filesVisited;
    stats.filesIndexed += result.filesIndexed;
    stats.filesSkipped += result.filesSkipped;
    stats.risks += result.risks;
    for (const ev of result.events) {
      yield ev;
    }
  };

  while (queue.length > 0) {
    const current = queue.shift()!;
    const skipDirReason = shouldSkipDirectory(current.path, cfg, current.depth);
    if (skipDirReason) {
      stats.filesSkipped += 1;
      yield { type: "file_skipped", path: current.path, reason: skipDirReason };
      continue;
    }

    stats.dirsVisited += 1;
    yield { type: "directory_entered", path: current.path };

    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(current.path, {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch (error) {
      stats.risks += 1;
      yield {
        type: "risk_flag",
        risk: {
          id: newId(),
          taskId,
          filePath: current.path,
          kind: "permission_denied",
          detail: (error as Error).message,
          stage: "readdir",
          createdAt: new Date().toISOString(),
        },
      };
      continue;
    }

    for (const entry of entries) {
      const fullPath = normalizePath(path.join(current.path, entry.name));
      if (entry.isDirectory()) {
        if (cfg.maxDepth !== undefined && current.depth >= cfg.maxDepth) {
          continue;
        }
        queue.push({ path: fullPath, depth: current.depth + 1 });
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }
      pushFileTask(fullPath);
      if (pendingFiles.size >= fileConcurrency) {
        const settled = await Promise.race([...pendingFiles]);
        pendingFiles.delete(settled.tracked);
        yield* applyFileResult(settled.result);
      }
    }
  }

  while (pendingFiles.size > 0) {
    const settled = await Promise.race([...pendingFiles]);
    pendingFiles.delete(settled.tracked);
    yield* applyFileResult(settled.result);
  }

  yield { type: "scan_finished", taskId, stats };
}

export const createTaskId = (): string => stableId(`${Date.now()}:${Math.random()}`);
