import fs from "node:fs/promises";
import { findDuplicateGroups } from "./core/dedupe.js";
import { exportBundleJson, exportToCsv, exportToJson } from "./core/exporters.js";
import { createTaskId, scanFiles } from "./core/scanner.js";
import { DuplicateGroup, FileAnalysisCacheEntry, FileRecord, RiskFlag, ScanConfig, ScanEvent, ScanResultBundle } from "./types.js";
import { SqliteStore } from "./storage/sqliteStore.js";

export interface RunScanOptions {
  taskId?: string;
  saveStatePath?: string;
  resumeStatePath?: string;
  onEvent?: (event: ScanEvent) => void;
  csvPath?: string;
  jsonPath?: string;
  bundleJsonPath?: string;
  dbPath?: string;
}

interface ScanState {
  taskId: string;
  indexedPaths: string[];
}

const loadState = async (filePath?: string): Promise<ScanState | null> => {
  if (!filePath) {
    return null;
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as ScanState;
  } catch {
    return null;
  }
};

const saveState = async (
  filePath: string | undefined,
  state: ScanState,
): Promise<void> => {
  if (!filePath) {
    return;
  }
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
};

export const runScanTask = async (
  cfg: ScanConfig,
  opts: RunScanOptions = {},
): Promise<{
  taskId: string;
  records: FileRecord[];
  duplicateGroups: DuplicateGroup[];
  riskFlags: RiskFlag[];
  bundle: ScanResultBundle;
}> => {
  const restored = await loadState(opts.resumeStatePath);
  const taskId = opts.taskId ?? restored?.taskId ?? createTaskId();
  const seen = new Set(restored?.indexedPaths ?? []);

  const store = opts.dbPath ? await SqliteStore.openOrCreate(opts.dbPath) : await SqliteStore.create();
  store.insertTask(taskId, cfg);
  const analysisCache = cfg.enableUnchangedFileCache === false
    ? undefined
    : new Map<string, FileAnalysisCacheEntry>(
      store.listFileAnalysisCache().map((entry) => [entry.path, entry]),
    );

  const records: FileRecord[] = [];
  const riskFlags: RiskFlag[] = [];

  try {
    for await (const ev of scanFiles(taskId, cfg, { analysisCache })) {
      opts.onEvent?.(ev);
      store.insertEvent(taskId, ev);

      if (ev.type === "file_indexed") {
        if (seen.has(ev.record.path)) {
          continue;
        }
        seen.add(ev.record.path);
        records.push(ev.record);
        store.insertFile(ev.record);
      }

      if (ev.type === "risk_flag") {
        riskFlags.push(ev.risk);
        store.insertRisk(ev.risk);
      }
    }

    const groups = await findDuplicateGroups(taskId, records, {
      quickBytes: cfg.quickHashBytes,
      concurrency: cfg.dedupeConcurrency,
      analysisCache,
    });
    for (const group of groups) {
      store.insertDuplicateGroup(group);
    }

    if (analysisCache) {
      for (const entry of analysisCache.values()) {
        store.upsertFileAnalysisCache(entry);
      }
    }

    if (opts.csvPath) {
      await exportToCsv(records, opts.csvPath);
    }
    if (opts.jsonPath) {
      await exportToJson(records, opts.jsonPath);
    }

    const duplicateFileCount = groups.reduce((sum, group) => sum + group.memberCount, 0);
    const duplicateWasteBytes = groups.reduce(
      (sum, group) => sum + Math.max(0, group.totalSize - group.members[0].size),
      0,
    );

    const bundle: ScanResultBundle = {
      taskId,
      createdAt: new Date().toISOString(),
      config: cfg,
      summary: {
        totalFiles: records.length,
        totalBytes: records.reduce((sum, row) => sum + row.size, 0),
        duplicateGroupCount: groups.length,
        duplicateFileCount,
        duplicateWasteBytes,
        riskCount: riskFlags.length,
      },
      records,
      duplicateGroups: groups,
      riskFlags,
    };

    if (opts.bundleJsonPath) {
      await exportBundleJson(bundle, opts.bundleJsonPath);
    }

    if (opts.dbPath) {
      await store.save();
    }

    await saveState(opts.saveStatePath, {
      taskId,
      indexedPaths: [...seen],
    });

    store.finishTask(taskId, "finished");
    if (opts.dbPath) {
      await store.save();
    }
    return { taskId, records, duplicateGroups: groups, riskFlags, bundle };
  } catch (error) {
    store.finishTask(taskId, "failed");
    if (opts.dbPath) {
      await store.save();
    }
    await saveState(opts.saveStatePath, {
      taskId,
      indexedPaths: [...seen],
    });
    throw error;
  }
};
