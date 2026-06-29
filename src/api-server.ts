import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as yazl from "yazl";
import { findDuplicateGroups } from "./core/dedupe.js";
import { createTaskId, scanFiles } from "./core/scanner.js";
import { SqliteStore } from "./storage/sqliteStore.js";
import { DuplicateGroup, FileAnalysisCacheEntry, RiskFlag, ScanConfig, ScanResultBundle, ScanStats } from "./types.js";

const HOST = "127.0.0.1";
const PORT = 5174;
const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "diskorg.sqlite");
const BUNDLE_DIR = path.join(DATA_DIR, "bundles");
const INSIGHT_SETTINGS_PATH = path.join(DATA_DIR, "insight-settings.json");
const RETENTION_SETTINGS_PATH = path.join(DATA_DIR, "retention-settings.json");
const execFileAsync = promisify(execFile);
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const LIVE_SCAN_RETENTION_MS = 30 * 60 * 1000;
const TRUSTED_LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const REQUIRED_CLIENT_HEADER = "x-diskorg-client";
const REQUIRED_CLIENT_VALUE = "atlas-ui";
const API_SESSION_TOKEN = process.env.DISKORG_API_TOKEN?.trim() || randomUUID();

type InsightProvider = "disabled" | "openai_compatible" | "ollama";

type InsightSettings = {
  provider: InsightProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  webSearchEnabled: boolean;
  temperature: number;
};

type InsightItem = {
  path: string;
  name: string;
  ext: string;
  size: number;
  isDir: boolean;
  mtimeMs?: number;
  scanStatus?: string;
};

type InsightResult = {
  summary: string;
  deletableAdvice: "safe" | "caution" | "unsafe" | "unknown";
  confidence: "high" | "medium" | "low";
  impact: string;
  reasons: string[];
  sourceHints: string[];
  searchEvidence: string[];
  provider: InsightProvider;
  model: string | null;
};

type RetentionSettings = {
  enabled: boolean;
  keepBundleDays: number;
  maxBundleFiles: number;
  keepTaskDays: number;
  keepAnalysisCacheDays: number;
};

type CompressionMode = "video" | "image" | "pdf" | "package";
type CompressionArchiveFormat = "zip" | "tar";
type VideoPreset = "extreme_720p" | "balanced_1080p" | "manual";
type VideoFormat = "mp4" | "mov" | "mkv";
type VideoBitrateMode = "dynamic" | "static";
type VideoResolution = "keep" | "1080p" | "720p" | "480p" | "360p" | "144p";
type VideoFrameRate = "keep" | "60" | "59.94" | "30" | "29.97" | "24" | "23.976" | "15" | "10";

type CompressionRequest = {
  mode: CompressionMode;
  inputPath: string;
  outputPath?: string;
  videoPreset?: VideoPreset;
  videoFormat?: VideoFormat;
  videoBitrateMode?: VideoBitrateMode;
  videoBitrateKbps?: number;
  videoResolution?: VideoResolution;
  videoFrameRate?: VideoFrameRate;
  imageStrategy?: "keep_resolution" | "resize_and_compress";
  imageQuality?: number;
  maxWidth?: number;
  maxHeight?: number;
  pdfPreset?: "screen" | "ebook" | "printer";
  targetSizeMb?: number;
  packageStoreOnly?: boolean;
  packageFormat?: CompressionArchiveFormat;
};

type CompressionResult = {
  ok: boolean;
  mode: CompressionMode;
  inputPath: string;
  outputPath: string;
  sourceSizeBytes: number;
  outputSizeBytes: number;
  ratio: number;
  message: string;
};

type CompressionBatchRequest = {
  mode: "video" | "package";
  inputPaths: string[];
  outputDir?: string;
  outputPath?: string;
  packageFormat?: CompressionArchiveFormat;
  packageStoreOnly?: boolean;
  videoPreset?: VideoPreset;
  videoFormat?: VideoFormat;
  videoBitrateMode?: VideoBitrateMode;
  videoBitrateKbps?: number;
  videoResolution?: VideoResolution;
  videoFrameRate?: VideoFrameRate;
};

type CompressionBatchResult = {
  ok: boolean;
  mode: "video" | "package";
  total: number;
  successCount: number;
  failCount: number;
  outputs: CompressionResult[];
  failures: Array<{ inputPath: string; message: string }>;
  outputPath?: string;
};

const defaultInsightSettings: InsightSettings = {
  provider: "disabled",
  baseUrl: "http://127.0.0.1:11434",
  model: "",
  apiKey: "",
  webSearchEnabled: true,
  temperature: 0.2,
};

const defaultRetentionSettings: RetentionSettings = {
  enabled: true,
  keepBundleDays: 14,
  maxBundleFiles: 20,
  keepTaskDays: 30,
  keepAnalysisCacheDays: 90,
};

let insightSettingsCache: InsightSettings | null = null;
let retentionSettingsCache: RetentionSettings | null = null;

const commandExists = async (command: string): Promise<boolean> => {
  try {
    await execFileAsync(command, ["--version"], { windowsHide: true });
    return true;
  } catch {
    try {
      await execFileAsync("where.exe", [command], { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }
};

type LiveScanStatus = "running" | "paused" | "cancelled" | "finished" | "failed";

type LiveScanTask = {
  taskId: string;
  config: ScanConfig;
  status: LiveScanStatus;
  phase: "indexing" | "dedupe" | "finished";
  phaseProgress: {
    stage: "indexing" | "quick_hash" | "full_hash";
    completed: number;
    total: number;
  };
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  lastIndexedAt: string | null;
  stats: ScanStats;
  totalBytes: number;
  records: ScanResultBundle["records"];
  riskFlags: RiskFlag[];
  duplicateGroups: DuplicateGroup[];
  error: string | null;
  pauseRequested: boolean;
  cancelRequested: boolean;
};

const liveScans = new Map<string, LiveScanTask>();

class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const normalizePathForMatch = (input: string): string => path.resolve(input).replace(/[\\/]+$/, "");

const isPathWithinRoot = (candidatePath: string, rootPath: string): boolean => {
  const candidate = normalizePathForMatch(candidatePath);
  const root = normalizePathForMatch(rootPath);
  const cmpCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const cmpRoot = process.platform === "win32" ? root.toLowerCase() : root;
  return cmpCandidate === cmpRoot || cmpCandidate.startsWith(`${cmpRoot}${path.sep}`);
};

const requireTrustedClient = (req: IncomingMessage): void => {
  const origin = String(req.headers.origin ?? "").trim();
  if (origin && !TRUSTED_LOCAL_ORIGIN.test(origin)) {
    throw new HttpError(403, "forbidden_origin");
  }

  const clientHeader = String(req.headers[REQUIRED_CLIENT_HEADER] ?? "").trim().toLowerCase();
  if (clientHeader !== REQUIRED_CLIENT_VALUE) {
    throw new HttpError(401, "unauthorized_client");
  }

  const tokenHeader = String(req.headers["x-diskorg-token"] ?? "").trim();
  if (tokenHeader !== API_SESSION_TOKEN) {
    throw new HttpError(401, "unauthorized_token");
  }
};

const loadAuthorizedRoots = async (): Promise<string[]> => {
  const latestLive = [...liveScans.values()]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  if (latestLive?.config.roots?.length) {
    return [...new Set(latestLive.config.roots.map((root) => normalizePathForMatch(root)))];
  }

  const store = await SqliteStore.openOrCreate(DB_PATH);
  const latestTask = store.listTasks(1)[0];
  if (!latestTask) {
    return [];
  }
  const config = store.getTaskConfig(latestTask.id);
  return config?.roots?.length
    ? [...new Set(config.roots.map((root) => normalizePathForMatch(root)))]
    : [];
};

const findOutOfRootPaths = (inputPaths: string[], roots: string[]): string[] => (
  inputPaths.filter((targetPath) => !roots.some((root) => isPathWithinRoot(targetPath, root)))
);

const scheduleLiveScanCleanup = (taskId: string): void => {
  const timer = setTimeout(() => {
    const task = liveScans.get(taskId);
    if (!task || task.status === "running") {
      return;
    }
    liveScans.delete(taskId);
  }, LIVE_SCAN_RETENTION_MS);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
};

const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-DiskOrg-Client, X-DiskOrg-Token",
  });
  res.end(JSON.stringify(payload));
};

const sendText = (res: ServerResponse, status: number, payload: string, contentType = "text/plain; charset=utf-8"): void => {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-DiskOrg-Client, X-DiskOrg-Token",
  });
  res.end(payload);
};

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new HttpError(413, "payload_too_large");
    }
    chunks.push(buf);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
};

const ensureDataDirs = async (): Promise<void> => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(BUNDLE_DIR, { recursive: true });
};

const summaryFromBundle = (bundle: ScanResultBundle) => ({
  id: bundle.taskId,
  taskId: bundle.taskId,
  createdAt: bundle.createdAt,
  status: "finished",
  roots: bundle.config.roots,
  totalFiles: bundle.summary.totalFiles,
  duplicateGroupCount: bundle.summary.duplicateGroupCount,
  riskCount: bundle.summary.riskCount,
});

const summaryFromLiveTask = (task: LiveScanTask) => {
  const duplicateFileCount = task.duplicateGroups.reduce((sum, group) => sum + group.memberCount, 0);
  const duplicateWasteBytes = task.duplicateGroups.reduce(
    (sum, group) => sum + Math.max(0, group.totalSize - (group.members[0]?.size ?? 0)),
    0,
  );

  return {
    totalFiles: task.records.length,
    totalBytes: task.totalBytes,
    duplicateGroupCount: task.duplicateGroups.length,
    duplicateFileCount,
    duplicateWasteBytes,
    riskCount: task.riskFlags.length,
  };
};

const startLiveScan = async (cfg: ScanConfig): Promise<LiveScanTask> => {
  const taskId = createTaskId();
  const now = new Date().toISOString();
  const task: LiveScanTask = {
    taskId,
    config: cfg,
    status: "running",
    phase: "indexing",
    phaseProgress: {
      stage: "indexing",
      completed: 0,
      total: 0,
    },
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    lastIndexedAt: null,
    stats: {
      dirsVisited: 0,
      filesVisited: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      risks: 0,
    },
    totalBytes: 0,
    records: [],
    riskFlags: [],
    duplicateGroups: [],
    error: null,
    pauseRequested: false,
    cancelRequested: false,
  };

  liveScans.set(taskId, task);

  void (async () => {
    let store: SqliteStore | null = null;
    try {
      store = await SqliteStore.openOrCreate(DB_PATH);
      store.insertTask(taskId, cfg);
      const analysisCache = cfg.enableUnchangedFileCache === false
        ? undefined
        : new Map<string, FileAnalysisCacheEntry>(
          store.listFileAnalysisCache().map((entry) => [entry.path, entry]),
        );

      for await (const ev of scanFiles(taskId, cfg, { analysisCache })) {
        if (task.cancelRequested) {
          task.status = "cancelled";
          task.finishedAt = new Date().toISOString();
          task.updatedAt = task.finishedAt;
          task.phase = "finished";
          task.records = [];
          task.riskFlags = [];
          task.duplicateGroups = [];
          task.totalBytes = 0;
          break;
        }

        if (task.pauseRequested) {
          task.status = "paused";
          task.finishedAt = new Date().toISOString();
          task.updatedAt = task.finishedAt;
          task.phase = "finished";
          break;
        }

        task.updatedAt = new Date().toISOString();
        store.insertEvent(taskId, ev);

        if (ev.type === "directory_entered") {
          task.stats.dirsVisited += 1;
        }

        if (ev.type === "file_seen") {
          task.stats.filesVisited += 1;
          task.phaseProgress = {
            stage: "indexing",
            completed: task.stats.filesVisited,
            total: task.stats.filesVisited,
          };
        }

        if (ev.type === "file_skipped") {
          task.stats.filesSkipped += 1;
        }

        if (ev.type === "risk_flag") {
          task.stats.risks += 1;
          task.riskFlags.push(ev.risk);
          store.insertRisk(ev.risk);
        }

        if (ev.type === "file_indexed") {
          task.stats.filesIndexed += 1;
          task.lastIndexedAt = task.updatedAt;
          task.records.push(ev.record);
          task.totalBytes += ev.record.size;
          store.insertFile(ev.record);
        }

        if (ev.type === "scan_finished") {
          task.stats = ev.stats;
        }
      }

      if (task.status === "running") {
        task.phase = "dedupe";
        task.phaseProgress = {
          stage: "quick_hash",
          completed: 0,
          total: 0,
        };
        const groups = await findDuplicateGroups(taskId, task.records, {
          quickBytes: cfg.quickHashBytes,
          concurrency: cfg.dedupeConcurrency,
          analysisCache,
          onProgress: (progress) => {
            task.phaseProgress = progress;
            task.updatedAt = new Date().toISOString();
          },
        });
        task.duplicateGroups = groups;
        for (const group of groups) {
          store.insertDuplicateGroup(group);
        }
        task.status = "finished";
        task.phase = "finished";
        task.finishedAt = new Date().toISOString();
        task.updatedAt = task.finishedAt;
      }

      if (analysisCache) {
        for (const entry of analysisCache.values()) {
          store.upsertFileAnalysisCache(entry);
        }
      }

      store.finishTask(taskId, task.status);
      await store.save();

      if (task.status === "finished") {
        const bundle: ScanResultBundle = {
          taskId,
          createdAt: task.startedAt,
          config: task.config,
          summary: summaryFromLiveTask(task),
          records: task.records,
          duplicateGroups: task.duplicateGroups,
          riskFlags: task.riskFlags,
        };
        await fs.writeFile(
          path.join(BUNDLE_DIR, `scan-${Date.now()}.json`),
          JSON.stringify(bundle, null, 2),
          "utf8",
        );
      }

      void cleanupRetentionArtifacts().catch(() => {
        // best-effort cleanup after each scan
      });
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.finishedAt = new Date().toISOString();
      task.updatedAt = task.finishedAt;
      if (store) {
        store.finishTask(taskId, "failed");
        await store.save();
      }
    } finally {
      if (task.status !== "running") {
        scheduleLiveScanCleanup(taskId);
      }
    }
  })();

  return task;
};

const buildTaskBundle = async (taskId: string): Promise<ScanResultBundle | null> => {
  const store = await SqliteStore.openOrCreate(DB_PATH);
  const config = store.getTaskConfig(taskId);
  if (!config) {
    return null;
  }

  const records = store.listFiles(taskId);
  const duplicateGroups = store.listDuplicateGroups(taskId);
  const riskFlags = store.listRisks(taskId);

  const duplicateFileCount = duplicateGroups.reduce((sum, group) => sum + group.memberCount, 0);
  const duplicateWasteBytes = duplicateGroups.reduce(
    (sum, group) => sum + Math.max(0, group.totalSize - (group.members[0]?.size ?? 0)),
    0,
  );

  const task = store.listTasks(500).find((item) => item.id === taskId);

  return {
    taskId,
    createdAt: task?.startedAt ?? new Date().toISOString(),
    config,
    summary: {
      totalFiles: records.length,
      totalBytes: records.reduce((sum, row) => sum + row.size, 0),
      duplicateGroupCount: duplicateGroups.length,
      duplicateFileCount,
      duplicateWasteBytes,
      riskCount: riskFlags.length,
    },
    records,
    duplicateGroups,
    riskFlags,
  };
};

const toConfig = (body: unknown): ScanConfig => {
  const payload = (body ?? {}) as Record<string, unknown>;
  const rootsRaw = payload.roots;

  const roots = Array.isArray(rootsRaw)
    ? rootsRaw.map((item) => String(item).trim()).filter(Boolean)
    : [String(payload.root ?? "").trim()].filter(Boolean);

  return {
    roots,
    minSizeBytes: payload.minSizeBytes ? Number(payload.minSizeBytes) : undefined,
    maxSizeBytes: payload.maxSizeBytes ? Number(payload.maxSizeBytes) : undefined,
    includeGlobs: Array.isArray(payload.includeGlobs)
      ? payload.includeGlobs.map((item) => String(item))
      : undefined,
    excludeGlobs: Array.isArray(payload.excludeGlobs)
      ? payload.excludeGlobs.map((item) => String(item))
      : undefined,
    excludePaths: Array.isArray(payload.excludePaths)
      ? payload.excludePaths.map((item) => String(item))
      : undefined,
    skipOneDrivePlaceholders: payload.skipOneDrivePlaceholders !== false,
    ioConcurrency: payload.ioConcurrency ? Number(payload.ioConcurrency) : undefined,
    dedupeConcurrency: payload.dedupeConcurrency ? Number(payload.dedupeConcurrency) : undefined,
    enableUnchangedFileCache: payload.enableUnchangedFileCache !== false,
  };
};

const toPathList = (body: unknown): string[] => {
  const payload = (body ?? {}) as Record<string, unknown>;
  const raw = payload.paths;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((item) => String(item).trim()).filter(Boolean);
};

type DeleteFailure = {
  path: string;
  message: string;
};

type DeleteResult = {
  deleted: string[];
  failed: DeleteFailure[];
};

const deleteFilePaths = async (paths: string[]): Promise<DeleteResult> => {
  const deleted: string[] = [];
  const failed: DeleteFailure[] = [];
  for (const filePath of paths) {
    try {
      await fs.rm(filePath, { force: true });
      deleted.push(filePath);
    } catch (error) {
      failed.push({
        path: filePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { deleted, failed };
};

const deleteDirectoryPaths = async (paths: string[]): Promise<DeleteResult> => {
  const deleted: string[] = [];
  const failed: DeleteFailure[] = [];
  for (const dirPath of paths) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      deleted.push(dirPath);
    } catch (error) {
      failed.push({
        path: dirPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { deleted, failed };
};

const copyPathsToClipboard = async (paths: string[]): Promise<{ copied: string[] }> => {
  const existing = (
    await Promise.all(
      paths.map(async (targetPath) => {
        try {
          await fs.access(targetPath);
          return targetPath;
        } catch {
          return null;
        }
      }),
    )
  ).filter((item): item is string => Boolean(item));

  if (existing.length === 0) {
    return { copied: [] };
  }

  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$paths = ConvertFrom-Json $env:DISKORG_PATHS_JSON",
      "$list = New-Object System.Collections.Specialized.StringCollection",
      "foreach ($item in $paths) { [void]$list.Add([string]$item) }",
      "if ($list.Count -eq 0) { throw 'no_paths' }",
      "[System.Windows.Forms.Clipboard]::SetFileDropList($list)",
    ].join("; ");

    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", script],
      {
        env: {
          ...process.env,
          DISKORG_PATHS_JSON: JSON.stringify(existing),
        },
        windowsHide: true,
      },
    );

    return { copied: existing };
  }

  if (process.platform === "linux") {
    const uris = existing.map((targetPath) => pathToFileURL(targetPath).href);
    const uriList = `${uris.join("\r\n")}\r\n`;
    const gnomePayload = `copy\n${uris.join("\n")}\n`;
    const desktop = String(process.env.XDG_CURRENT_DESKTOP ?? process.env.DESKTOP_SESSION ?? "").toLowerCase();
    const preferGnomePayload = /(gnome|ubuntu|unity|cinnamon|mate|nautilus)/.test(desktop);

    if (await commandExists("wl-copy")) {
      await execFileAsync(
        "wl-copy",
        ["--type", "text/uri-list"],
        {
          input: uriList,
          windowsHide: true,
        } as never,
      );
      return { copied: existing };
    }

    if (await commandExists("xclip")) {
      await execFileAsync(
        "xclip",
        [
          "-selection",
          "clipboard",
          "-t",
          preferGnomePayload ? "x-special/gnome-copied-files" : "text/uri-list",
        ],
        {
          input: preferGnomePayload ? gnomePayload : uriList,
          windowsHide: true,
        } as never,
      );
      return { copied: existing };
    }

    if (await commandExists("xsel")) {
      await execFileAsync(
        "xsel",
        [
          "--clipboard",
          "--input",
          "--mime-type",
          preferGnomePayload ? "x-special/gnome-copied-files" : "text/uri-list",
        ],
        {
          input: preferGnomePayload ? gnomePayload : uriList,
          windowsHide: true,
        } as never,
      );
      return { copied: existing };
    }

    throw new Error("copy_clipboard_linux_tool_missing");
  }

  throw new Error("copy_clipboard_unsupported_platform");
};

const toDuplicateCsv = (bundle: ScanResultBundle): string => {
  const lines: string[] = [
    "group_id,full_hash,member_count,total_size,reclaimable_size,file_path,file_size",
  ];

  for (const group of bundle.duplicateGroups) {
    const keepSize = group.members[0]?.size ?? 0;
    const reclaimableSize = Math.max(0, group.totalSize - keepSize);

    for (const member of group.members) {
      const escapedPath = `\"${member.path.replaceAll("\"", "\"\"")}\"`;
      lines.push(
        [
          group.id,
          group.fullHash,
          String(group.memberCount),
          String(group.totalSize),
          String(reclaimableSize),
          escapedPath,
          String(member.size),
        ].join(","),
      );
    }
  }

  return lines.join("\n");
};

const sanitizeInsightSettings = (input: unknown): InsightSettings => {
  const obj = (input ?? {}) as Record<string, unknown>;
  const providerRaw = String(obj.provider ?? defaultInsightSettings.provider);
  const provider: InsightProvider =
    providerRaw === "openai_compatible" || providerRaw === "ollama"
      ? providerRaw
      : "disabled";

  const baseUrl = String(obj.baseUrl ?? defaultInsightSettings.baseUrl).trim() || defaultInsightSettings.baseUrl;
  const model = String(obj.model ?? "").trim();
  const apiKey = String(obj.apiKey ?? "").trim();
  const webSearchEnabled = obj.webSearchEnabled !== false;
  const tempRaw = Number(obj.temperature ?? defaultInsightSettings.temperature);
  const temperature = Number.isFinite(tempRaw) ? Math.max(0, Math.min(1, tempRaw)) : defaultInsightSettings.temperature;

  return {
    provider,
    baseUrl,
    model,
    apiKey,
    webSearchEnabled,
    temperature,
  };
};

const loadInsightSettings = async (): Promise<InsightSettings> => {
  if (insightSettingsCache) {
    return insightSettingsCache;
  }

  try {
    const raw = await fs.readFile(INSIGHT_SETTINGS_PATH, "utf8");
    insightSettingsCache = sanitizeInsightSettings(JSON.parse(raw));
    return insightSettingsCache;
  } catch {
    insightSettingsCache = { ...defaultInsightSettings };
    return insightSettingsCache;
  }
};

const saveInsightSettings = async (settings: InsightSettings): Promise<void> => {
  insightSettingsCache = settings;
  await fs.writeFile(INSIGHT_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
};

const sanitizeRetentionSettings = (input: unknown): RetentionSettings => {
  const obj = (input ?? {}) as Record<string, unknown>;
  const intWithin = (value: unknown, fallback: number, min: number, max: number): number => {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, Math.trunc(num)));
  };

  return {
    enabled: obj.enabled !== false,
    keepBundleDays: intWithin(obj.keepBundleDays, defaultRetentionSettings.keepBundleDays, 1, 3650),
    maxBundleFiles: intWithin(obj.maxBundleFiles, defaultRetentionSettings.maxBundleFiles, 1, 5000),
    keepTaskDays: intWithin(obj.keepTaskDays, defaultRetentionSettings.keepTaskDays, 1, 3650),
    keepAnalysisCacheDays: intWithin(obj.keepAnalysisCacheDays, defaultRetentionSettings.keepAnalysisCacheDays, 1, 3650),
  };
};

const loadRetentionSettings = async (): Promise<RetentionSettings> => {
  if (retentionSettingsCache) {
    return retentionSettingsCache;
  }

  try {
    const raw = await fs.readFile(RETENTION_SETTINGS_PATH, "utf8");
    retentionSettingsCache = sanitizeRetentionSettings(JSON.parse(raw));
    return retentionSettingsCache;
  } catch {
    retentionSettingsCache = { ...defaultRetentionSettings };
    return retentionSettingsCache;
  }
};

const saveRetentionSettings = async (settings: RetentionSettings): Promise<void> => {
  retentionSettingsCache = settings;
  await fs.writeFile(RETENTION_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
};

const DAY_MS = 24 * 60 * 60 * 1000;

const cleanupOldBundles = async (settings: RetentionSettings): Promise<void> => {
  let entries: Array<{ isFile: () => boolean; name: string }> = [];
  try {
    entries = await fs.readdir(BUNDLE_DIR, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }

  const files = entries.filter((entry) => entry.isFile());
  const metadata: Array<{ filePath: string; mtimeMs: number }> = [];

  for (const file of files) {
    const filePath = path.join(BUNDLE_DIR, file.name);
    try {
      const stat = await fs.stat(filePath);
      metadata.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch {
      // ignore file race
    }
  }

  metadata.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const now = Date.now();
  const maxAgeMs = settings.keepBundleDays * DAY_MS;
  const toDelete = new Set<string>();

  for (let i = settings.maxBundleFiles; i < metadata.length; i += 1) {
    toDelete.add(metadata[i].filePath);
  }

  for (const item of metadata) {
    if ((now - item.mtimeMs) > maxAgeMs) {
      toDelete.add(item.filePath);
    }
  }

  for (const filePath of toDelete) {
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore file-in-use / already removed
    }
  }
};

const cleanupRetentionArtifacts = async (): Promise<void> => {
  await ensureDataDirs();
  const settings = await loadRetentionSettings();
  if (!settings.enabled) {
    return;
  }

  await cleanupOldBundles(settings);

  const store = await SqliteStore.openOrCreate(DB_PATH);
  const cutoffTaskIso = new Date(Date.now() - settings.keepTaskDays * DAY_MS).toISOString();
  const oldTaskIds = store.listTaskIdsOlderThan(cutoffTaskIso);
  for (const taskId of oldTaskIds) {
    store.deleteTaskData(taskId);
  }

  const cutoffCacheIso = new Date(Date.now() - settings.keepAnalysisCacheDays * DAY_MS).toISOString();
  store.pruneFileAnalysisCacheOlderThan(cutoffCacheIso);
  await store.save();
};

const withDefaultOutputPath = (
  inputPath: string,
  outputPath: string | undefined,
  mode: CompressionMode,
  req?: CompressionRequest,
): string => {
  if (outputPath && outputPath.trim()) {
    return outputPath.trim();
  }

  const parsed = path.parse(inputPath);
  if (mode === "video") {
    const ext = req?.videoPreset === "manual" ? (req.videoFormat ?? "mp4") : "mp4";
    return path.join(parsed.dir, `${parsed.name}.compressed.${ext}`);
  }
  if (mode === "image") {
    return path.join(parsed.dir, `${parsed.name}.compressed.webp`);
  }
  if (mode === "pdf") {
    return path.join(parsed.dir, `${parsed.name}.compressed.pdf`);
  }
  return path.join(parsed.dir, `${parsed.name || "archive"}.bundle.zip`);
};

const readSourceSize = async (inputPath: string): Promise<number> => {
  const stat = await fs.stat(inputPath);
  if (stat.isFile()) {
    return stat.size;
  }

  const walk = async (dir: string): Promise<number> => {
    let sum = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    for (const entry of entries) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        sum += await walk(next);
      } else if (entry.isFile()) {
        const child = await fs.stat(next);
        sum += child.size;
      }
    }
    return sum;
  };

  return walk(inputPath);
};

const parseFps = (rate: string | undefined): number | null => {
  if (!rate || !rate.includes("/")) {
    return null;
  }
  const [a, b] = rate.split("/").map((v) => Number(v));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return null;
  }
  const fps = a / b;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
};

const probeVideoMeta = async (inputPath: string): Promise<{ fps: number; width: number; height: number }> => {
  if (!(await commandExists("ffprobe"))) {
    return { fps: 30, width: 1920, height: 1080 };
  }

  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate,r_frame_rate",
      "-of",
      "json",
      inputPath,
    ],
    { windowsHide: true, maxBuffer: 10 * 1024 * 1024 } as never,
  );

  const parsed = JSON.parse(String(stdout)) as {
    streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }>;
  };

  const stream = parsed.streams?.[0] ?? {};
  const fps = parseFps(stream.avg_frame_rate) ?? parseFps(stream.r_frame_rate) ?? 30;
  const width = Number(stream.width ?? 1920);
  const height = Number(stream.height ?? 1080);
  return { fps, width, height };
};

const pickVideoBitrate = (height: number, fps: number, preset: VideoPreset) => {
  const fpsTier = fps > 50 ? "60" : "30";
  const table = {
    2160: { "30": 14000, "60": 20000 },
    1440: { "30": 9000, "60": 13000 },
    1080: { "30": 6000, "60": 9000 },
    720: { "30": 3500, "60": 5000 },
    480: { "30": 2500, "60": 3000 },
  } as const;

  const bucket = height >= 1800 ? 2160 : height >= 1260 ? 1440 : height >= 900 ? 1080 : height >= 650 ? 720 : 480;
  const base = table[bucket][fpsTier as "30" | "60"];
  const factor = preset === "extreme_720p" ? 0.38 : preset === "balanced_1080p" ? 0.72 : 0.72;
  return Math.max(800, Math.round(base * factor));
};

const resolutionToHeight = (resolution: VideoResolution | undefined): number | null => {
  if (!resolution || resolution === "keep") {
    return null;
  }
  const map: Record<Exclude<VideoResolution, "keep">, number> = {
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "360p": 360,
    "144p": 144,
  };
  return map[resolution];
};

const frameRateToNumber = (frameRate: VideoFrameRate | undefined): number | null => {
  if (!frameRate || frameRate === "keep") {
    return null;
  }
  const parsed = Number(frameRate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const runVideoCompression = async (req: CompressionRequest, outputPath: string): Promise<void> => {
  if (!(await commandExists("ffmpeg"))) {
    throw new Error("ffmpeg_not_found");
  }

  const preset = req.videoPreset ?? "balanced_1080p";
  const meta = await probeVideoMeta(req.inputPath);
  const sourceFps = Math.max(1, Math.round(meta.fps * 1000) / 1000);
  const manualMode = preset === "manual";
  const targetHeight = manualMode
    ? (resolutionToHeight(req.videoResolution) ?? meta.height)
    : (preset === "extreme_720p" ? 720 : 1080);
  const targetFps = manualMode
    ? (frameRateToNumber(req.videoFrameRate) ?? sourceFps)
    : sourceFps;
  const resolvedVideoKbps = manualMode
    ? Math.max(200, Math.min(100000, Math.trunc(req.videoBitrateKbps ?? pickVideoBitrate(Math.min(meta.height, targetHeight), targetFps, "balanced_1080p"))))
    : pickVideoBitrate(Math.min(meta.height, targetHeight), targetFps, preset);
  const bitrateMode: VideoBitrateMode = req.videoBitrateMode === "static" ? "static" : "dynamic";
  const audioKbps = manualMode
    ? Math.max(64, Math.min(256, Math.round(resolvedVideoKbps / 36)))
    : (preset === "extreme_720p" ? 96 : 128);
  const scaleFilter = targetHeight >= meta.height
    ? "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    : `scale='if(gt(iw,ih),min(iw,${Math.round((targetHeight * 16) / 9)}),-2)':'if(gt(iw,ih),-2,min(ih,${targetHeight}))':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  const format: VideoFormat = req.videoFormat === "mov" || req.videoFormat === "mkv" ? req.videoFormat : "mp4";

  const args: string[] = [
    "-y",
    "-i",
    req.inputPath,
    "-vf",
    scaleFilter,
  ];

  if (Math.abs(targetFps - sourceFps) > 0.001) {
    args.push("-r", String(targetFps));
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    manualMode ? "slow" : "medium",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
  );

  if (manualMode && bitrateMode === "dynamic") {
    args.push(
      "-crf",
      "23",
      "-maxrate",
      `${resolvedVideoKbps}k`,
      "-bufsize",
      `${Math.round(resolvedVideoKbps * 2)}k`,
    );
  } else if (manualMode && bitrateMode === "static") {
    args.push(
      "-b:v",
      `${resolvedVideoKbps}k`,
      "-minrate",
      `${resolvedVideoKbps}k`,
      "-maxrate",
      `${resolvedVideoKbps}k`,
      "-bufsize",
      `${Math.round(resolvedVideoKbps * 2)}k`,
    );
  } else {
    args.push(
      "-b:v",
      `${resolvedVideoKbps}k`,
      "-maxrate",
      `${Math.round(resolvedVideoKbps * 1.2)}k`,
      "-bufsize",
      `${Math.round(resolvedVideoKbps * 2.4)}k`,
    );
  }

  args.push(
    "-c:a",
    "aac",
    "-b:a",
    `${audioKbps}k`,
  );

  if (format === "mp4" || format === "mov") {
    args.push("-movflags", "+faststart");
  }

  args.push(outputPath);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync("ffmpeg", args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 } as never);
};

const runImageCompression = async (req: CompressionRequest, outputPath: string): Promise<void> => {
  if (!(await commandExists("ffmpeg"))) {
    throw new Error("ffmpeg_not_found");
  }

  const strategy = req.imageStrategy ?? "keep_resolution";
  const quality = Math.max(20, Math.min(95, Math.trunc(req.imageQuality ?? 82)));
  const filter = strategy === "resize_and_compress"
    ? `scale='min(iw,${Math.max(64, Math.trunc(req.maxWidth ?? 1920))})':'min(ih,${Math.max(64, Math.trunc(req.maxHeight ?? 1080))})':force_original_aspect_ratio=decrease`
    : "scale=iw:ih";

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      req.inputPath,
      "-vf",
      filter,
      "-c:v",
      "libwebp",
      "-quality",
      String(quality),
      "-compression_level",
      "6",
      outputPath,
    ],
    { windowsHide: true, maxBuffer: 10 * 1024 * 1024 } as never,
  );
};

const runPdfCompression = async (req: CompressionRequest, outputPath: string): Promise<void> => {
  const candidates = ["gswin64c", "gswin32c", "gs"];
  let gsCmd = "";
  for (const cmd of candidates) {
    if (await commandExists(cmd)) {
      gsCmd = cmd;
      break;
    }
  }

  if (!gsCmd) {
    throw new Error("ghostscript_not_found");
  }

  const preset = req.pdfPreset ?? "ebook";
  const profile = preset === "screen" ? "/screen" : preset === "printer" ? "/printer" : "/ebook";
  const targetSizeMb = Number(req.targetSizeMb ?? 0);
  const profileChain = targetSizeMb > 0 ? ["/screen", "/ebook", "/printer"] : [profile];

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  let bestPath = outputPath;
  let bestSize = Number.POSITIVE_INFINITY;

  for (let i = 0; i < profileChain.length; i += 1) {
    const tempOut = profileChain.length === 1 ? outputPath : `${outputPath}.tmp.${i}.pdf`;
    await execFileAsync(
      gsCmd,
      [
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.6",
        `-dPDFSETTINGS=${profileChain[i]}`,
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        `-sOutputFile=${tempOut}`,
        req.inputPath,
      ],
      { windowsHide: true, maxBuffer: 10 * 1024 * 1024 } as never,
    );

    const stat = await fs.stat(tempOut);
    if (stat.size < bestSize) {
      bestSize = stat.size;
      bestPath = tempOut;
    }
    if (targetSizeMb > 0 && stat.size <= targetSizeMb * 1024 * 1024) {
      bestPath = tempOut;
      bestSize = stat.size;
      break;
    }
  }

  if (bestPath !== outputPath) {
    await fs.copyFile(bestPath, outputPath);
  }

  if (profileChain.length > 1) {
    for (let i = 0; i < profileChain.length; i += 1) {
      const tmp = `${outputPath}.tmp.${i}.pdf`;
      try {
        await fs.unlink(tmp);
      } catch {
        // ignore
      }
    }
  }
};

const listFilesRecursively = async (inputPath: string): Promise<Array<{ absPath: string; relPath: string }>> => {
  const stat = await fs.stat(inputPath);
  if (stat.isFile()) {
    return [{ absPath: inputPath, relPath: path.basename(inputPath) }];
  }

  const rootParent = path.dirname(inputPath);
  const out: Array<{ absPath: string; relPath: string }> = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath);
      } else if (entry.isFile()) {
        out.push({
          absPath,
          relPath: path.relative(rootParent, absPath).replaceAll("\\", "/"),
        });
      }
    }
  };

  await walk(inputPath);
  return out;
};

const findCommonAncestor = (paths: string[]): string => {
  if (paths.length === 0) {
    return process.cwd();
  }

  const resolved = paths.map((p) => path.resolve(p));
  let current = resolved[0];

  const isPrefix = (candidate: string, target: string): boolean => {
    const c = candidate.toLowerCase();
    const t = target.toLowerCase();
    return t === c || t.startsWith(`${c}${path.sep}`);
  };

  for (let i = 1; i < resolved.length; i += 1) {
    const target = resolved[i];
    while (!isPrefix(current, target)) {
      const parent = path.dirname(current);
      if (parent === current) {
        return path.parse(current).root || process.cwd();
      }
      current = parent;
    }
  }

  return current;
};

const listFilesFromInputs = async (inputPaths: string[]): Promise<Array<{ absPath: string; relPath: string }>> => {
  const normalized = [...new Set(inputPaths.map((p) => p.trim()).filter(Boolean))];
  const existing: string[] = [];
  const missing: string[] = [];
  for (const input of normalized) {
    try {
      await fs.access(input);
      existing.push(input);
    } catch {
      missing.push(input);
    }
  }

  if (missing.length > 0) {
    throw new Error(`missing_input_paths:${missing.join("|")}`);
  }

  const commonRoot = findCommonAncestor(existing.length > 0 ? existing : normalized);
  const out: Array<{ absPath: string; relPath: string }> = [];

  const pushFile = (absPath: string) => {
    let relPath = path.relative(commonRoot, absPath).replaceAll("\\", "/");
    if (!relPath || relPath.startsWith("..")) {
      relPath = path.basename(absPath);
    }
    out.push({ absPath, relPath });
  };

  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath);
      } else if (entry.isFile()) {
        pushFile(absPath);
      }
    }
  };

  for (const input of existing) {
    const stat = await fs.stat(input);
    if (stat.isFile()) {
      pushFile(input);
    } else if (stat.isDirectory()) {
      await walk(input);
    }
  }

  return out;
};

const runPackageZip = async (req: CompressionRequest, outputPath: string): Promise<void> => {
  const files = await listFilesRecursively(req.inputPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const sink = createWriteStream(outputPath);
    sink.on("close", () => resolve());
    sink.on("error", reject);

    for (const file of files) {
      zip.addFile(file.absPath, file.relPath, { compress: req.packageStoreOnly === false ? true : false });
    }
    zip.end();
    zip.outputStream.pipe(sink);
  });
};

const runPackageZipFromInputs = async (
  inputPaths: string[],
  outputPath: string,
  packageStoreOnly: boolean,
): Promise<void> => {
  const files = await listFilesFromInputs(inputPaths);
  if (files.length === 0) {
    throw new Error("no_input_files");
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const sink = createWriteStream(outputPath);
    sink.on("close", () => resolve());
    sink.on("error", reject);

    for (const file of files) {
      zip.addFile(file.absPath, file.relPath, { compress: packageStoreOnly ? false : true });
    }
    zip.end();
    zip.outputStream.pipe(sink);
  });
};

const runPackageTarFromInputs = async (inputPaths: string[], outputPath: string): Promise<void> => {
  if (!(await commandExists("tar"))) {
    throw new Error("tar_not_found");
  }
  const normalized = [...new Set(inputPaths.map((p) => p.trim()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new Error("input_paths_required");
  }

  const commonRoot = findCommonAncestor(normalized);
  const relInputs = normalized.map((p) => {
    const rel = path.relative(commonRoot, path.resolve(p));
    if (!rel || rel.startsWith("..")) {
      throw new Error("tar_inputs_must_share_common_root");
    }
    return rel;
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync(
    "tar",
    ["-cf", outputPath, "--", ...relInputs],
    { cwd: commonRoot, windowsHide: true, maxBuffer: 50 * 1024 * 1024 } as never,
  );
};

const runCompression = async (payload: CompressionRequest): Promise<CompressionResult> => {
  const inputPath = payload.inputPath.trim();
  if (!inputPath) {
    throw new Error("input_path_required");
  }

  await fs.access(inputPath);
  const outputPath = withDefaultOutputPath(inputPath, payload.outputPath, payload.mode, payload);

  if (payload.mode === "video") {
    await runVideoCompression(payload, outputPath);
  } else if (payload.mode === "image") {
    await runImageCompression(payload, outputPath);
  } else if (payload.mode === "pdf") {
    await runPdfCompression(payload, outputPath);
  } else {
    await runPackageZip(payload, outputPath);
  }

  const sourceSizeBytes = await readSourceSize(inputPath);
  const outputSizeBytes = (await fs.stat(outputPath)).size;
  const ratio = sourceSizeBytes > 0 ? outputSizeBytes / sourceSizeBytes : 1;

  return {
    ok: true,
    mode: payload.mode,
    inputPath,
    outputPath,
    sourceSizeBytes,
    outputSizeBytes,
    ratio,
    message: "done",
  };
};

const runCompressionBatch = async (payload: CompressionBatchRequest): Promise<CompressionBatchResult> => {
  const inputPaths = [...new Set(payload.inputPaths.map((p) => p.trim()).filter(Boolean))];
  if (inputPaths.length === 0) {
    throw new Error("input_paths_required");
  }

  if (payload.mode === "package") {
    const format: CompressionArchiveFormat = payload.packageFormat === "tar" ? "tar" : "zip";
    const defaultPath = path.join(
      path.dirname(inputPaths[0]),
      `batch-package.${format}`,
    );
    const outputPath = (payload.outputPath && payload.outputPath.trim()) || defaultPath;

    if (format === "zip") {
      await runPackageZipFromInputs(inputPaths, outputPath, payload.packageStoreOnly !== false);
    } else {
      await runPackageTarFromInputs(inputPaths, outputPath);
    }

    const sourceSizeBytes = (await Promise.all(inputPaths.map((p) => readSourceSize(p)))).reduce((a, b) => a + b, 0);
    const outputSizeBytes = (await fs.stat(outputPath)).size;
    const summaryResult: CompressionResult = {
      ok: true,
      mode: "package",
      inputPath: `${inputPaths.length} items`,
      outputPath,
      sourceSizeBytes,
      outputSizeBytes,
      ratio: sourceSizeBytes > 0 ? outputSizeBytes / sourceSizeBytes : 1,
      message: "done",
    };

    return {
      ok: true,
      mode: "package",
      total: inputPaths.length,
      successCount: inputPaths.length,
      failCount: 0,
      outputs: [summaryResult],
      failures: [],
      outputPath,
    };
  }

  const outputDir = (payload.outputDir && payload.outputDir.trim()) || undefined;
  if (outputDir) {
    await fs.mkdir(outputDir, { recursive: true });
  }

  const outputs: CompressionResult[] = [];
  const failures: Array<{ inputPath: string; message: string }> = [];
  for (const inputPath of inputPaths) {
    try {
      const parsed = path.parse(inputPath);
      const ext = payload.videoPreset === "manual" ? (payload.videoFormat ?? "mp4") : "mp4";
      const targetPath = outputDir ? path.join(outputDir, `${parsed.name}.compressed.${ext}`) : undefined;
      const result = await runCompression({
        mode: "video",
        inputPath,
        outputPath: targetPath,
        videoPreset: payload.videoPreset,
        videoFormat: payload.videoFormat,
        videoBitrateMode: payload.videoBitrateMode,
        videoBitrateKbps: payload.videoBitrateKbps,
        videoResolution: payload.videoResolution,
        videoFrameRate: payload.videoFrameRate,
      });
      outputs.push(result);
    } catch (error) {
      failures.push({
        inputPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: failures.length === 0,
    mode: "video",
    total: inputPaths.length,
    successCount: outputs.length,
    failCount: failures.length,
    outputs,
    failures,
  };
};

const toInsightItems = (body: unknown): InsightItem[] => {
  const payload = (body ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  return rawItems
    .map((item) => {
      const entry = item as Record<string, unknown>;
      const itemPath = String(entry.path ?? "").trim();
      if (!itemPath) {
        return null;
      }
      const name = String(entry.name ?? path.basename(itemPath)).trim() || path.basename(itemPath);
      const ext = String(entry.ext ?? path.extname(itemPath)).toLowerCase();
      const size = Number(entry.size ?? 0);
      const isDir = entry.isDir === true;
      const mtimeRaw = Number(entry.mtimeMs);
      const scanStatus = typeof entry.scanStatus === "string" ? entry.scanStatus.trim() : "";
      const result: InsightItem = {
        path: itemPath,
        name,
        ext,
        size: Number.isFinite(size) ? Math.max(0, size) : 0,
        isDir,
      };
      if (Number.isFinite(mtimeRaw)) {
        result.mtimeMs = Math.max(0, mtimeRaw);
      }
      if (scanStatus) {
        result.scanStatus = scanStatus;
      }
      return result;
    })
    .filter((item): item is InsightItem => Boolean(item));
};

const buildSearchQueries = (items: InsightItem[]): string[] => {
  const queries: string[] = [];
  for (const item of items.slice(0, 3)) {
    const leaf = item.name || path.basename(item.path);
    const kind = item.isDir ? "folder" : "file";
    queries.push(`${leaf} ${kind} can I delete`);
    if (item.ext) {
      queries.push(`${item.ext} ${kind} purpose safe to delete`);
    }
  }
  return [...new Set(queries)].slice(0, 5);
};

const extractDdgTexts = (node: unknown): string[] => {
  if (!node || typeof node !== "object") {
    return [];
  }

  const obj = node as Record<string, unknown>;
  const direct = typeof obj.Text === "string" ? [obj.Text.trim()] : [];
  if (Array.isArray(obj.Topics)) {
    return [
      ...direct,
      ...obj.Topics.flatMap((child) => extractDdgTexts(child)),
    ];
  }

  return direct;
};

const fetchDuckDuckGoEvidence = async (query: string): Promise<string[]> => {
  const endpoint = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": "DiskOrg-Atlas/1.0",
    },
  });

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const results: string[] = [];

  const heading = String(payload.Heading ?? "").trim();
  const abstractText = String(payload.AbstractText ?? "").trim();
  if (heading && abstractText) {
    results.push(`${heading}: ${abstractText}`);
  } else if (abstractText) {
    results.push(abstractText);
  }

  const related = Array.isArray(payload.RelatedTopics)
    ? payload.RelatedTopics.flatMap((node) => extractDdgTexts(node))
    : [];
  for (const text of related) {
    if (!text) continue;
    results.push(text);
    if (results.length >= 4) {
      break;
    }
  }

  return results.slice(0, 4);
};

const collectSearchEvidence = async (items: InsightItem[]): Promise<string[]> => {
  const queries = buildSearchQueries(items);
  const snippets: string[] = [];
  for (const query of queries) {
    try {
      const rows = await fetchDuckDuckGoEvidence(query);
      for (const row of rows) {
        snippets.push(`[${query}] ${row}`);
        if (snippets.length >= 8) {
          return snippets;
        }
      }
    } catch {
      // best-effort; ignore transient search failures
    }
  }
  return snippets;
};

const formatBytesHuman = (size: number): string => {
  if (!Number.isFinite(size) || size < 0) {
    return "unknown";
  }
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
};

const toSizeBucket = (size: number): string => {
  if (size < 1024 * 1024) return "small";
  if (size < 1024 ** 3) return "medium";
  if (size < 1024 ** 4) return "large";
  return "very_large";
};

const guessLikelyPurpose = (items: InsightItem[]): string[] => {
  const notes: string[] = [];
  for (const item of items) {
    const lower = item.path.toLowerCase();
    if (/(^|[\\/])node_modules([\\/]|$)/.test(lower)) {
      notes.push("Looks like dependency directory. Deleting may break project builds until reinstall.");
    }
    if (/(^|[\\/])(cache|caches|tmp|temp|thumbnails)([\\/]|$)/.test(lower)) {
      notes.push("Looks like cache/temp data. Often safe to remove, but apps may rebuild it.");
    }
    if (/(^|[\\/])(windows|system32|program files|programdata)([\\/]|$)/.test(lower)) {
      notes.push("Path appears system-critical. Deletion can destabilize OS or installed apps.");
    }
  }
  return [...new Set(notes)].slice(0, 4);
};

const isSystemCriticalPath = (lowerPath: string): boolean =>
  /(^|[\\/])(windows|system32|program files|programdata)([\\/]|$)/.test(lowerPath);

const isCacheLikePath = (lowerPath: string): boolean => {
  const segments = lowerPath.split(/[\\/]+/).filter(Boolean);
  return segments.some((segment) => (
    segment === "cache"
    || segment === "caches"
    || segment === "tmp"
    || segment === "temp"
    || segment === "thumbnails"
    || segment.includes("cache")
    || segment.includes("temp")
  ));
};

const applyInsightPostRules = (
  result: InsightResult,
  items: InsightItem[],
  lang: "zh" | "en",
): InsightResult => {
  let adjusted = { ...result };

  const now = Date.now();
  const OCCUPIED_WINDOW_MS = 2 * 60 * 60 * 1000;
  const COLD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
  const knownMtimes = items
    .map((item) => Number(item.mtimeMs))
    .filter((value) => Number.isFinite(value) && value > 0);
  const newestMtime = knownMtimes.length > 0 ? Math.max(...knownMtimes) : null;
  const newestAgeMs = newestMtime === null ? null : (now - newestMtime);
  const likelyOccupied = newestAgeMs !== null && newestAgeMs >= 0 && newestAgeMs <= OCCUPIED_WINDOW_MS;
  const looksCold = newestAgeMs !== null && newestAgeMs > COLD_WINDOW_MS;

  const loweredPaths = items.map((item) => item.path.toLowerCase());
  const hasSystemCritical = loweredPaths.some(isSystemCriticalPath);
  const hasCacheLike = loweredPaths.some(isCacheLikePath);

  const stepHints = [
    likelyOccupied
      ? "step1_occupied:likely"
      : newestAgeMs === null
        ? "step1_occupied:unknown"
        : "step1_occupied:unlikely",
    hasCacheLike && !hasSystemCritical
      ? "step2_purpose:rebuildable_cache"
      : hasSystemCritical
        ? "step2_purpose:system_critical_pattern"
        : "step2_purpose:non_cache_or_unknown",
    looksCold
      ? "step3_time:cold"
      : newestAgeMs === null
        ? "step3_time:unknown"
        : "step3_time:recent_or_warm",
  ];

  adjusted = {
    ...adjusted,
    sourceHints: [...new Set([...adjusted.sourceHints, ...stepHints])].slice(0, 5),
  };

  // Step 1: occupied check has highest priority.
  if (likelyOccupied) {
    adjusted = {
      ...adjusted,
      deletableAdvice: adjusted.deletableAdvice === "safe" ? "caution" : adjusted.deletableAdvice,
      confidence: "low",
      impact: lang === "zh"
        ? "检测到近期修改，可能正在被应用占用；清理前建议先关闭相关程序并再次确认。"
        : "Recent modifications detected; data may be in active use. Close related apps before cleanup.",
      reasons: [
        lang === "zh"
          ? "最近 2 小时内有修改记录，存在仍在写入或占用的可能。"
          : "Modified within the last 2 hours, so writes/locks may still be active.",
        ...adjusted.reasons,
      ].slice(0, 3),
      sourceHints: [...new Set([...adjusted.sourceHints, "local_activity_heuristic:recent_mtime"])].slice(0, 5),
    };
  }

  // Step 2: purpose check (rebuildable cache-like path).
  if (!hasCacheLike || hasSystemCritical) {
    return adjusted;
  }

  const cacheReasons = lang === "zh"
    ? [
      "路径名称包含 cache/temp 等模式，更像应用缓存或临时数据。",
      "未命中系统关键目录模式，误删系统文件的概率较低。",
      "删除后通常可由应用重建，但首次启动可能更慢。",
    ]
    : [
      "Path contains cache/temp-like patterns, suggesting app cache or temporary data.",
      "No system-critical path pattern was detected, lowering OS-level deletion risk.",
      "Data is often rebuildable, but first app launch may be slower after cleanup.",
    ];
  const occupancyReason = lang === "zh"
    ? "最近 2 小时内有修改记录，存在仍在写入或占用的可能。"
    : "Modified within the last 2 hours, so writes/locks may still be active.";
  const reasons = likelyOccupied
    ? [occupancyReason, ...cacheReasons].slice(0, 3)
    : cacheReasons;

  // Step 3: time check refines confidence for cache-like targets.
  const deletableAdvice: InsightResult["deletableAdvice"] = likelyOccupied
    ? "caution"
    : (looksCold ? "safe" : "caution");
  const confidence: InsightResult["confidence"] = likelyOccupied
    ? "low"
    : (looksCold ? "medium" : "medium");
  const summary = lang === "zh"
    ? (likelyOccupied
      ? "该目录更像应用缓存/临时数据，但存在近期活动，建议先关闭应用后再清理。"
      : looksCold
        ? "该目录更像可重建缓存，且长期无新写入，可按“先隔离后删除”流程清理。"
        : "该目录更像应用缓存/临时数据，可考虑清理，但建议先确认未被占用。")
    : (likelyOccupied
      ? "This looks like app cache/temp data, but recent activity suggests active use. Close apps before cleanup."
      : looksCold
        ? "This looks like rebuildable cache with no recent writes; cleanup via quarantine-first is usually reasonable."
        : "This looks like app cache/temp data; cleanup is usually possible with caution.");
  const impact = lang === "zh"
    ? (likelyOccupied
      ? "可能释放空间，但目录有近期写入迹象，建议关闭应用后再清理。"
      : looksCold
        ? "大概率可释放空间；若相关工程再次打开，应用可能重新生成缓存。"
        : "可能释放磁盘空间；应用下次运行可能触发缓存重建。")
    : (likelyOccupied
      ? "May free space, but recent writes suggest active use; close apps before cleanup."
      : looksCold
        ? "Likely frees space; related apps may regenerate cache on next use."
        : "May free disk space; next app run may rebuild cache.");

  return {
    ...adjusted,
    summary,
    deletableAdvice,
    confidence,
    impact,
    reasons,
    sourceHints: [...new Set([...adjusted.sourceHints, "local_path_heuristic:cache_like_path"])].slice(0, 5),
  };
};

const parseJsonObjectFromText = (text: string): Record<string, unknown> | null => {
  const direct = text.trim();
  try {
    return JSON.parse(direct) as Record<string, unknown>;
  } catch {
    // ignore
  }

  const start = direct.indexOf("{");
  const end = direct.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = direct.slice(start, end + 1);
    try {
      return JSON.parse(sliced) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return null;
};

const normalizeInsightResult = (
  parsed: Record<string, unknown> | null,
  lang: "zh" | "en",
  fallbackEvidence: string[],
  provider: InsightProvider,
  model: string,
): InsightResult => {
  const unknownSummary = lang === "zh"
    ? "我不知道该目录下的文件是什么内容，如果需要删除请小心。"
    : "I don't know what these files contain. Please delete carefully.";

  if (!parsed) {
    return {
      summary: unknownSummary,
      deletableAdvice: "unknown",
      confidence: "low",
      impact: lang === "zh" ? "未获得高置信度结论。" : "No high-confidence conclusion was obtained.",
      reasons: [],
      sourceHints: [],
      searchEvidence: fallbackEvidence,
      provider,
      model: model || null,
    };
  }

  const confidenceRaw = String(parsed.confidence ?? "low").toLowerCase();
  const confidence: InsightResult["confidence"] =
    confidenceRaw === "high" || confidenceRaw === "medium" ? confidenceRaw : "low";
  const adviceRaw = String(parsed.deletableAdvice ?? "unknown").toLowerCase();
  const deletableAdvice: InsightResult["deletableAdvice"] =
    adviceRaw === "safe" || adviceRaw === "caution" || adviceRaw === "unsafe"
      ? adviceRaw
      : "unknown";

  const summary = String(parsed.summary ?? "").trim() || unknownSummary;
  const impact = String(parsed.impact ?? "").trim() || (lang === "zh" ? "缺少影响说明。" : "Impact explanation is missing.");
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.map((x) => String(x).trim()).filter(Boolean).slice(0, 5)
    : [];
  const sourceHints = Array.isArray(parsed.sourceHints)
    ? parsed.sourceHints.map((x) => String(x).trim()).filter(Boolean).slice(0, 5)
    : [];

  return {
    summary,
    deletableAdvice,
    confidence,
    impact,
    reasons,
    sourceHints,
    searchEvidence: fallbackEvidence,
    provider,
    model: model || null,
  };
};

const callOpenAiCompatible = async (
  settings: InsightSettings,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> => {
  const endpoint = `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: settings.temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`llm_openai_failed_${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return String(payload.choices?.[0]?.message?.content ?? "");
};

const callOllama = async (
  settings: InsightSettings,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> => {
  const endpoint = `${settings.baseUrl.replace(/\/$/, "")}/api/chat`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      options: {
        temperature: settings.temperature,
      },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`llm_ollama_failed_${response.status}`);
  }

  const payload = (await response.json()) as {
    message?: { content?: string };
  };
  return String(payload.message?.content ?? "");
};

const analyzeWithLlm = async (
  settings: InsightSettings,
  items: InsightItem[],
  lang: "zh" | "en",
  searchEvidence: string[],
): Promise<InsightResult> => {
  const heuristicNotes = guessLikelyPurpose(items);
  const itemLines = items.map((item) => (
    `${item.isDir ? "DIR" : "FILE"} | path=${item.path} | name=${item.name} | ext=${item.ext || "(none)"} | sizeBytes=${item.size} | sizeHuman=${formatBytesHuman(item.size)} | sizeBucket=${toSizeBucket(item.size)} | mtimeMs=${item.mtimeMs ?? "(unknown)"} | scanStatus=${item.scanStatus ?? "(unknown)"} | directorySizeSemantics=${item.isDir ? "aggregated_descendant_bytes" : "file_bytes"}`
  ));

  const systemPrompt = lang === "zh"
    ? "你是文件清理助手。你必须输出严格 JSON，不要输出额外文字。禁止臆测容量单位，必须以 sizeBytes/sizeHuman 为准。"
    : "You are a file cleanup assistant. Return strict JSON only, no extra text. Never hallucinate size units; use sizeBytes/sizeHuman only.";

  const userPrompt = [
    lang === "zh"
      ? "请根据文件路径/类型和外部检索片段，判断这些项目是什么，以及是否建议删除。"
      : "Use file paths/types and search snippets to infer what these items are and whether deletion is recommended.",
    "",
    lang === "zh"
      ? "关键规则: 不能只根据体积大小做风险判断。若缺乏路径模式、外部证据或启发式支持，只能给 confidence=low 且 deletableAdvice=unknown。"
      : "Critical rule: never base risk judgment on size alone. If path patterns, external evidence, and heuristics are missing, you must return confidence=low and deletableAdvice=unknown.",
    "",
    "items:",
    ...itemLines,
    "",
    lang === "zh"
      ? "重要约束: DIR 项目的 size 是目录下所有子项聚合字节，不是单个文件大小；不要据此判断磁盘物理容量。"
      : "Important constraint: for DIR items, size is aggregated descendant bytes, not a single file size; do not infer physical disk capacity from this.",
    "",
    "heuristics:",
    ...(heuristicNotes.length > 0 ? heuristicNotes : ["(none)"]),
    "",
    "web_snippets:",
    ...(searchEvidence.length > 0 ? searchEvidence : ["(none_or_unavailable)"]),
    "",
    lang === "zh"
      ? "输出 JSON 字段: summary, deletableAdvice(safe|caution|unsafe|unknown), confidence(high|medium|low), impact, reasons(string[]), sourceHints(string[])。reasons 最多 3 条，每条一句。"
      : "Output JSON fields: summary, deletableAdvice(safe|caution|unsafe|unknown), confidence(high|medium|low), impact, reasons(string[]), sourceHints(string[]). Keep reasons <=3 one-liners.",
  ].join("\n");

  let content = "";
  if (settings.provider === "openai_compatible") {
    content = await callOpenAiCompatible(settings, systemPrompt, userPrompt);
  } else if (settings.provider === "ollama") {
    content = await callOllama(settings, systemPrompt, userPrompt);
  }

  const parsed = parseJsonObjectFromText(content);
  return normalizeInsightResult(parsed, lang, searchEvidence, settings.provider, settings.model);
};

const server = createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }

    if (req.method === "OPTIONS") {
      sendText(res, 204, "");
      return;
    }

    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/api/session") {
      const origin = String(req.headers.origin ?? "").trim();
      if (origin && !TRUSTED_LOCAL_ORIGIN.test(origin)) {
        sendJson(res, 403, { error: "forbidden_origin" });
        return;
      }
      sendJson(res, 200, { token: API_SESSION_TOKEN });
      return;
    }

    if (req.method === "GET" && pathname === "/api/tasks") {
      await ensureDataDirs();
      const store = await SqliteStore.openOrCreate(DB_PATH);
      const tasks = store.listTasks(200).map((task) => ({
        id: task.id,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        status: task.status,
        roots: task.roots,
      }));
      await store.save();
      sendJson(res, 200, { tasks });
      return;
    }

    if (req.method === "GET" && pathname === "/api/insight/settings") {
      await ensureDataDirs();
      const settings = await loadInsightSettings();
      sendJson(res, 200, settings);
      return;
    }

    if (req.method === "GET" && pathname === "/api/retention/settings") {
      await ensureDataDirs();
      const settings = await loadRetentionSettings();
      sendJson(res, 200, settings);
      return;
    }

    if (req.method === "POST" && pathname === "/api/insight/settings") {
      await ensureDataDirs();
      const body = await readJsonBody(req);
      const nextSettings = sanitizeInsightSettings(body);
      await saveInsightSettings(nextSettings);
      sendJson(res, 200, nextSettings);
      return;
    }

    if (req.method === "POST" && pathname === "/api/retention/settings") {
      await ensureDataDirs();
      const body = await readJsonBody(req);
      const nextSettings = sanitizeRetentionSettings(body);
      await saveRetentionSettings(nextSettings);
      void cleanupRetentionArtifacts().catch(() => {
        // best-effort immediate cleanup after settings update
      });
      sendJson(res, 200, nextSettings);
      return;
    }

    if (req.method === "POST" && pathname === "/api/compress/run") {
      const body = await readJsonBody(req);
      const payload = (body ?? {}) as Record<string, unknown>;
      const mode = String(payload.mode ?? "").toLowerCase();
      if (mode !== "video" && mode !== "image" && mode !== "pdf" && mode !== "package") {
        sendJson(res, 400, { error: "invalid_mode" });
        return;
      }

      const reqPayload: CompressionRequest = {
        mode,
        inputPath: String(payload.inputPath ?? ""),
        outputPath: payload.outputPath ? String(payload.outputPath) : undefined,
        videoPreset: payload.videoPreset === "manual" ? "manual" : payload.videoPreset as CompressionRequest["videoPreset"],
        videoFormat: payload.videoFormat === "mov" || payload.videoFormat === "mkv" ? payload.videoFormat : "mp4",
        videoBitrateMode: payload.videoBitrateMode === "static" ? "static" : "dynamic",
        videoBitrateKbps: Number(payload.videoBitrateKbps),
        videoResolution: payload.videoResolution as CompressionRequest["videoResolution"],
        videoFrameRate: payload.videoFrameRate as CompressionRequest["videoFrameRate"],
        imageStrategy: payload.imageStrategy as CompressionRequest["imageStrategy"],
        imageQuality: Number(payload.imageQuality),
        maxWidth: Number(payload.maxWidth),
        maxHeight: Number(payload.maxHeight),
        pdfPreset: payload.pdfPreset as CompressionRequest["pdfPreset"],
        targetSizeMb: Number(payload.targetSizeMb),
        packageStoreOnly: payload.packageStoreOnly !== false,
      };

      try {
        const result = await runCompression(reqPayload);
        sendJson(res, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: "compress_failed", message });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/compress/batch") {
      const body = await readJsonBody(req);
      const payload = (body ?? {}) as Record<string, unknown>;
      const mode = String(payload.mode ?? "").toLowerCase();
      if (mode !== "video" && mode !== "package") {
        sendJson(res, 400, { error: "invalid_mode" });
        return;
      }

      const inputPaths = Array.isArray(payload.inputPaths)
        ? payload.inputPaths.map((v) => String(v ?? "")).filter(Boolean)
        : [];

      const reqPayload: CompressionBatchRequest = {
        mode,
        inputPaths,
        outputDir: payload.outputDir ? String(payload.outputDir) : undefined,
        outputPath: payload.outputPath ? String(payload.outputPath) : undefined,
        packageFormat: payload.packageFormat === "tar" ? "tar" : "zip",
        packageStoreOnly: payload.packageStoreOnly !== false,
        videoPreset: payload.videoPreset === "manual" ? "manual" : payload.videoPreset as CompressionBatchRequest["videoPreset"],
        videoFormat: payload.videoFormat === "mov" || payload.videoFormat === "mkv" ? payload.videoFormat : "mp4",
        videoBitrateMode: payload.videoBitrateMode === "static" ? "static" : "dynamic",
        videoBitrateKbps: Number(payload.videoBitrateKbps),
        videoResolution: payload.videoResolution as CompressionBatchRequest["videoResolution"],
        videoFrameRate: payload.videoFrameRate as CompressionBatchRequest["videoFrameRate"],
      };

      try {
        const result = await runCompressionBatch(reqPayload);
        sendJson(res, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 400, { error: "compress_batch_failed", message });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/insight/analyze") {
      await ensureDataDirs();
      const body = await readJsonBody(req);
      const payload = (body ?? {}) as Record<string, unknown>;
      const items = toInsightItems(payload);
      const lang = String(payload.lang ?? "zh").toLowerCase() === "en" ? "en" : "zh";
      if (items.length === 0) {
        sendJson(res, 400, { error: "items_required" });
        return;
      }

      const settings = await loadInsightSettings();
      const searchEvidence = settings.webSearchEnabled ? await collectSearchEvidence(items) : [];
      const effectiveEvidence = settings.webSearchEnabled && searchEvidence.length === 0
        ? ["[websearch] enabled_but_no_snippets_returned"]
        : searchEvidence;

      if (settings.provider === "disabled" || !settings.model) {
        sendJson(res, 200, {
          summary: lang === "zh"
            ? "我不知道该目录下的文件是什么内容，如果需要删除请小心。"
            : "I don't know what these files contain. Please delete carefully.",
          deletableAdvice: "unknown",
          confidence: "low",
          impact: lang === "zh"
            ? "未配置可用模型，无法给出高置信度判断。"
            : "No model is configured, so high-confidence judgment is unavailable.",
          reasons: [],
          sourceHints: [],
          searchEvidence: effectiveEvidence,
          provider: settings.provider,
          model: settings.model || null,
        } satisfies InsightResult);
        return;
      }

      const result = await analyzeWithLlm(settings, items, lang, effectiveEvidence);
      const adjusted = applyInsightPostRules(result, items, lang);
      sendJson(res, 200, adjusted);
      return;
    }

    if (req.method === "POST" && pathname === "/api/scan/start") {
      await ensureDataDirs();
      const body = await readJsonBody(req);
      const cfg = toConfig(body);

      if (cfg.roots.length === 0) {
        sendJson(res, 400, { error: "roots_required" });
        return;
      }

      const hasRunning = [...liveScans.values()].some((task) => task.status === "running");
      if (hasRunning) {
        sendJson(res, 409, { error: "scan_already_running" });
        return;
      }

      const task = await startLiveScan(cfg);
      sendJson(res, 202, {
        taskId: task.taskId,
        status: task.status,
      });
      return;
    }

    if (req.method === "GET" && /^\/api\/scan\/[^/]+\/status$/.test(pathname)) {
      const taskId = pathname.split("/")[3] ?? "";
      const task = liveScans.get(taskId);
      if (!task) {
        sendJson(res, 404, { error: "task_not_found" });
        return;
      }

      const summary = summaryFromLiveTask(task);
      const endAnchor = task.status === "running" ? Date.now() : Date.parse(task.finishedAt ?? task.updatedAt);
      const elapsedMs = endAnchor - Date.parse(task.startedAt);
      sendJson(res, 200, {
        taskId: task.taskId,
        status: task.status,
        phase: task.phase,
        phaseProgress: task.phaseProgress,
        startedAt: task.startedAt,
        updatedAt: task.updatedAt,
        finishedAt: task.finishedAt,
        lastIndexedAt: task.lastIndexedAt,
        elapsedMs,
        stats: task.stats,
        summary,
        error: task.error,
        riskFlags: task.riskFlags,
        duplicateGroups: task.duplicateGroups,
        totalRecords: task.records.length,
      });
      return;
    }

    if (req.method === "GET" && /^\/api\/scan\/[^/]+\/records$/.test(pathname)) {
      const taskId = pathname.split("/")[3] ?? "";
      const task = liveScans.get(taskId);
      if (!task) {
        sendJson(res, 404, { error: "task_not_found" });
        return;
      }

      const fromRaw = Number(url.searchParams.get("from") ?? "0");
      const from = Number.isFinite(fromRaw) && fromRaw > 0 ? Math.floor(fromRaw) : 0;
      const limitRaw = Number(url.searchParams.get("limit") ?? "500");
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(2000, Math.floor(limitRaw)) : 500;

      const records = task.records.slice(from, from + limit);
      sendJson(res, 200, {
        taskId,
        from,
        nextFrom: from + records.length,
        total: task.records.length,
        records,
      });
      return;
    }

    if (req.method === "POST" && /^\/api\/scan\/[^/]+\/pause$/.test(pathname)) {
      const taskId = pathname.split("/")[3] ?? "";
      const task = liveScans.get(taskId);
      if (!task) {
        sendJson(res, 404, { error: "task_not_found" });
        return;
      }
      if (task.status !== "running") {
        sendJson(res, 409, { error: "task_not_running", status: task.status });
        return;
      }
      task.pauseRequested = true;
      sendJson(res, 202, { taskId, status: "pausing" });
      return;
    }

    if (req.method === "POST" && /^\/api\/scan\/[^/]+\/cancel$/.test(pathname)) {
      const taskId = pathname.split("/")[3] ?? "";
      const task = liveScans.get(taskId);
      if (!task) {
        sendJson(res, 404, { error: "task_not_found" });
        return;
      }
      if (task.status !== "running") {
        sendJson(res, 409, { error: "task_not_running", status: task.status });
        return;
      }
      task.cancelRequested = true;
      task.status = "cancelled";
      task.phase = "finished";
      task.records = [];
      task.riskFlags = [];
      task.duplicateGroups = [];
      task.totalBytes = 0;
      task.updatedAt = new Date().toISOString();
      scheduleLiveScanCleanup(taskId);
      sendJson(res, 202, { taskId, status: "cancelled" });
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/tasks/") && pathname.endsWith("/bundle")) {
      const taskId = pathname.replace("/api/tasks/", "").replace("/bundle", "");
      const bundle = await buildTaskBundle(taskId);
      if (!bundle) {
        sendJson(res, 404, { error: "task_not_found" });
        return;
      }
      sendJson(res, 200, bundle);
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/api/tasks/") && pathname.endsWith("/duplicate-groups.csv")) {
      const taskId = pathname.replace("/api/tasks/", "").replace("/duplicate-groups.csv", "");
      const bundle = await buildTaskBundle(taskId);
      if (!bundle) {
        sendJson(res, 404, { error: "task_not_found" });
        return;
      }
      const csv = toDuplicateCsv(bundle);
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=duplicate-groups-${taskId}.csv`,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(csv);
      return;
    }

    if (req.method === "POST" && pathname === "/api/scan") {
      sendJson(res, 410, { error: "deprecated_use_scan_start" });
      return;
    }

    if (req.method === "POST" && pathname === "/api/delete-files") {
      requireTrustedClient(req);
      const body = await readJsonBody(req);
      const paths = toPathList(body);
      if (paths.length === 0) {
        sendJson(res, 400, { error: "paths_required" });
        return;
      }
      const roots = await loadAuthorizedRoots();
      if (roots.length === 0) {
        sendJson(res, 409, { error: "no_authorized_roots" });
        return;
      }
      const outside = findOutOfRootPaths(paths, roots);
      if (outside.length > 0) {
        sendJson(res, 403, { error: "path_outside_scanned_roots", paths: outside });
        return;
      }
      const result = await deleteFilePaths(paths);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/delete-directories") {
      requireTrustedClient(req);
      const body = await readJsonBody(req);
      const paths = toPathList(body);
      if (paths.length === 0) {
        sendJson(res, 400, { error: "paths_required" });
        return;
      }
      const roots = await loadAuthorizedRoots();
      if (roots.length === 0) {
        sendJson(res, 409, { error: "no_authorized_roots" });
        return;
      }
      const outside = findOutOfRootPaths(paths, roots);
      if (outside.length > 0) {
        sendJson(res, 403, { error: "path_outside_scanned_roots", paths: outside });
        return;
      }
      const result = await deleteDirectoryPaths(paths);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/copy-items") {
      requireTrustedClient(req);
      const body = await readJsonBody(req);
      const paths = toPathList(body);
      if (paths.length === 0) {
        sendJson(res, 400, { error: "paths_required" });
        return;
      }
      const roots = await loadAuthorizedRoots();
      if (roots.length === 0) {
        sendJson(res, 409, { error: "no_authorized_roots" });
        return;
      }
      const outside = findOutOfRootPaths(paths, roots);
      if (outside.length > 0) {
        sendJson(res, 403, { error: "path_outside_scanned_roots", paths: outside });
        return;
      }
      const result = await copyPathsToClipboard(paths);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.status, { error: error.code });
      return;
    }
    sendJson(res, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, async () => {
  await ensureDataDirs();
  process.stdout.write(`DiskOrg API server listening on http://${HOST}:${PORT}\n`);
  void cleanupRetentionArtifacts().catch(() => {
    // best-effort startup cleanup
  });
});
