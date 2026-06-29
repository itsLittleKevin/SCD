import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "@mdi/react";
import { mdiTranslate } from "@mdi/js";
import { Lang, t } from "./i18n";

type ScanRow = {
  path: string;
  parentPath?: string;
  name?: string;
  ext?: string;
  size: number;
  ctimeMs?: number;
  mtimeMs?: number;
  atimeMs?: number;
  fsType?: string;
  platform?: string;
  scanStatus?: string;
  isDir?: boolean;
};

type DirectorySummaryRow = {
  itemType: "dir";
  path: string;
  parentPath: string;
  name: string;
  ext: string;
  size: number;
  ctimeMs?: number;
  mtimeMs?: number;
  atimeMs?: number;
  fsType?: string;
  platform?: string;
  scanStatus?: string;
  isDir: true;
  fileCount: number;
  dirCount: number;
};

type FileDisplayRow = ScanRow & { itemType: "file"; isDir?: false };
type DisplayRow = FileDisplayRow | DirectorySummaryRow;

type DuplicateGroupView = {
  id: string;
  fullHash: string;
  memberCount: number;
  totalSize: number;
  members: Array<{ path: string; size: number }>;
};

type RiskFlagView = {
  filePath: string;
  kind: string;
  detail: string;
};

type ScanBundleView = {
  config?: {
    roots?: string[];
  };
  records: ScanRow[];
  duplicateGroups: DuplicateGroupView[];
  riskFlags: RiskFlagView[];
};

type TaskSummaryView = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  roots: string[];
};

type LiveScanStatusView = "running" | "paused" | "cancelled" | "finished" | "failed";
type LiveScanPhaseView = "indexing" | "dedupe" | "finished";

type LiveScanStatsView = {
  dirsVisited: number;
  filesVisited: number;
  filesIndexed: number;
  filesSkipped: number;
  risks: number;
};

type LiveScanSummaryView = {
  totalFiles: number;
  totalBytes: number;
  duplicateGroupCount: number;
  duplicateFileCount: number;
  duplicateWasteBytes: number;
  riskCount: number;
};

type LiveScanStatusPayload = {
  taskId: string;
  status: LiveScanStatusView;
  phase?: LiveScanPhaseView;
  phaseProgress?: {
    stage: "indexing" | "quick_hash" | "full_hash";
    completed: number;
    total: number;
  };
  startedAt: string;
  updatedAt: string;
  lastIndexedAt: string | null;
  elapsedMs: number;
  stats: LiveScanStatsView;
  summary: LiveScanSummaryView;
  error: string | null;
  riskFlags: RiskFlagView[];
  duplicateGroups: DuplicateGroupView[];
  totalRecords: number;
};

type InsightProvider = "disabled" | "openai_compatible" | "ollama";

type InsightSettingsPayload = {
  provider: InsightProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  webSearchEnabled: boolean;
  temperature: number;
};

type RetentionSettingsPayload = {
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

type CompressionRequestPayload = {
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
};

type CompressionResultPayload = {
  ok: boolean;
  mode: CompressionMode;
  inputPath: string;
  outputPath: string;
  sourceSizeBytes: number;
  outputSizeBytes: number;
  ratio: number;
  message: string;
};

type CompressionBatchRequestPayload = {
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

type CompressionBatchResultPayload = {
  ok: boolean;
  mode: "video" | "package";
  total: number;
  successCount: number;
  failCount: number;
  outputs: CompressionResultPayload[];
  failures: Array<{ inputPath: string; message: string }>;
  outputPath?: string;
};

type InsightResultPayload = {
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

type SortKey = "size" | "path" | "name" | "mtimeMs" | "ext";
type Unit = "B" | "KB" | "MB" | "GB";
type TimeFormat = "24h" | "ampm";
type DateFormat = "ymd" | "mdy" | "dmy";
type FooterTab = "compress" | "insight" | "retention";

type LoadedState =
  | { kind: "loading" }
  | { kind: "ready"; bundle: ScanBundleView }
  | { kind: "error"; message: string };

const createEmptyBundle = (roots: string[] = []): ScanBundleView => ({
  config: roots.length > 0 ? { roots } : undefined,
  records: [],
  duplicateGroups: [],
  riskFlags: [],
});

function InfoTip({ content, triggerLabel }: { content: string; triggerLabel?: string }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!pinned) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setPinned(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [pinned]);

  const open = pinned || hovered;

  useEffect(() => {
    if (!open) {
      return;
    }

    const updatePosition = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }

      const viewportWidth = window.innerWidth;
      const minWidth = 220;
      const maxWidth = Math.min(520, viewportWidth - 24);
      const asciiChars = content.replace(/[^\x00-\x7F]/g, "").length;
      const asciiRatio = content.length > 0 ? asciiChars / content.length : 1;
      const estimatedWidth = content.length * (asciiRatio > 0.75 ? 5.6 : 10) + 38;
      const width = Math.max(minWidth, Math.min(maxWidth, estimatedWidth));
      const left = Math.max(12, Math.min(rect.left, viewportWidth - width - 12));
      const top = Math.min(rect.bottom + 8, window.innerHeight - 24);
      setPosition({ top, left, width });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  return (
    <span
      className="info-tip"
      ref={rootRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={`info-tip-trigger ${open ? "is-open" : ""}`}
        aria-label={triggerLabel ?? "More information"}
        aria-expanded={open}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          setPinned((current) => !current);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
        }}
      >
        <span className="info-tip-icon">ⓘ</span>
        {triggerLabel ? <span>{triggerLabel}</span> : null}
      </button>
      {open && position
        ? createPortal(
            <span
              className="info-tip-popover"
              style={{
                position: "fixed",
                top: `${position.top}px`,
                left: `${position.left}px`,
                width: `${position.width}px`,
              }}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

const unitMap: Record<Unit, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
};

const zhPinyinCollator = new Intl.Collator("zh-CN-u-co-pinyin", {
  numeric: true,
  sensitivity: "base",
});

const enCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

const NO_EXT = "(none)";
const ODD_EXT = "(odd-ext)";
const TABLE_ROW_HEIGHT = 52;
const TABLE_OVERSCAN = 16;
const TABLE_COLUMN_COUNT = 6;
const SUFFIX_VISIBLE_LIMIT = 80;

const getDisplayName = (row: ScanRow): string => row.name ?? row.path.split(/[\\/]/).pop() ?? row.path;

const getParentPath = (inputPath: string): string => {
  const trimmed = inputPath.replace(/[\\/]+$/, "");
  const slashIndex = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (slashIndex <= 0) {
    return "";
  }
  return trimmed.slice(0, slashIndex);
};

const getBaseName = (inputPath: string): string => {
  const trimmed = inputPath.replace(/[\\/]+$/, "");
  const slashIndex = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
};

const normalizeComparablePath = (inputPath: string): string => inputPath.replace(/[\\/]+$/, "").toLowerCase();

const isSameOrChildPath = (candidatePath: string, rootPath: string): boolean => {
  const candidate = normalizeComparablePath(candidatePath);
  const root = normalizeComparablePath(rootPath);
  if (!root) {
    return false;
  }
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(`${root}\\`) || candidate.startsWith(`${root}/`);
};

const isDirectorySummary = (row: DisplayRow): row is DirectorySummaryRow => row.itemType === "dir";

const formatKindLabel = (kind: string, lang: Lang): string => {
  const key = kind.toLowerCase();
  if (lang === "zh") {
    if (key === "directory") return "目录";
    if (key === "video") return "视频";
    if (key === "image") return "图片";
    if (key === "document") return "文档";
    if (key === "archive") return "归档";
    if (key === "cache-like") return "缓存类";
    if (key === "other") return "其他";
    return kind;
  }

  if (key === "directory") return "directory";
  if (key === "video") return "video";
  if (key === "image") return "image";
  if (key === "document") return "document";
  if (key === "archive") return "archive";
  if (key === "cache-like") return "cache-like";
  if (key === "other") return "other";
  return kind;
};

const getDisplayKind = (row: DisplayRow, lang: Lang): string =>
  formatKindLabel(isDirectorySummary(row) ? "directory" : deriveKind(row), lang);

const formatScanStatus = (status: string | undefined, lang: Lang): string => {
  const normalized = String(status ?? "indexed").trim().toLowerCase();
  if (normalized === "indexed") {
    return lang === "zh" ? "已索引" : "Indexed";
  }
  if (normalized === "skipped") {
    return lang === "zh" ? "已跳过" : "Skipped";
  }
  if (normalized === "failed") {
    return lang === "zh" ? "失败" : "Failed";
  }
  return status?.trim() || (lang === "zh" ? "已索引" : "Indexed");
};

const buildDirectorySummaries = (fileRows: ScanRow[], scanRoots: string[]): DirectorySummaryRow[] => {
  const summaries = new Map<
    string,
    DirectorySummaryRow & {
      childDirSet: Set<string>;
      directFileCount: number;
    }
  >();
  const normalizedRoots = scanRoots.map((root) => root.replace(/[\\/]+$/, "")).filter(Boolean);

  const ensureSummary = (dirPath: string): DirectorySummaryRow & { childDirSet: Set<string>; directFileCount: number } => {
    const existing = summaries.get(dirPath);
    if (existing) {
      return existing;
    }
    const created = {
      itemType: "dir" as const,
      path: dirPath,
      parentPath: getParentPath(dirPath),
      name: getBaseName(dirPath),
      ext: "",
      size: 0,
      ctimeMs: undefined,
      mtimeMs: undefined,
      atimeMs: undefined,
      fsType: undefined,
      platform: undefined,
      scanStatus: "indexed",
      isDir: true as const,
      fileCount: 0,
      dirCount: 0,
      childDirSet: new Set<string>(),
      directFileCount: 0,
    };
    summaries.set(dirPath, created);
    return created;
  };

  for (const row of fileRows) {
    let currentDir = row.parentPath || getParentPath(row.path);
    let childDirPath = "";
    const owningRoot = normalizedRoots.find((root) => isSameOrChildPath(row.path, root)) ?? "";

    while (currentDir) {
      if (owningRoot && !isSameOrChildPath(currentDir, owningRoot)) {
        break;
      }
      const summary = ensureSummary(currentDir);
      summary.size += row.size;
      summary.mtimeMs = Math.max(summary.mtimeMs ?? 0, row.mtimeMs ?? 0) || summary.mtimeMs;
      summary.ctimeMs = Math.max(summary.ctimeMs ?? 0, row.ctimeMs ?? 0) || summary.ctimeMs;
      summary.atimeMs = Math.max(summary.atimeMs ?? 0, row.atimeMs ?? 0) || summary.atimeMs;
      summary.fsType ??= row.fsType;
      summary.platform ??= row.platform;

      if (row.parentPath === currentDir) {
        summary.directFileCount += 1;
      }

      if (childDirPath) {
        summary.childDirSet.add(childDirPath);
        summary.dirCount = summary.childDirSet.size;
      }

      childDirPath = currentDir;
      if (owningRoot && normalizeComparablePath(currentDir) === normalizeComparablePath(owningRoot)) {
        break;
      }
      currentDir = getParentPath(currentDir);
    }
  }

  const aggregateCache = new Map<string, { fileCount: number; dirCount: number }>();
  const accumulateCounts = (dirPath: string): { fileCount: number; dirCount: number } => {
    const cached = aggregateCache.get(dirPath);
    if (cached) {
      return cached;
    }

    const summary = summaries.get(dirPath);
    if (!summary) {
      return { fileCount: 0, dirCount: 0 };
    }

    let fileCount = summary.directFileCount;
    let dirCount = summary.childDirSet.size;
    for (const childDir of summary.childDirSet) {
      const childCounts = accumulateCounts(childDir);
      fileCount += childCounts.fileCount;
      dirCount += childCounts.dirCount;
    }

    const result = { fileCount, dirCount };
    aggregateCache.set(dirPath, result);
    return result;
  };

  return [...summaries.values()]
    .map(({ childDirSet: _childDirSet, directFileCount: _directFileCount, ...summary }) => {
      const aggregate = accumulateCounts(summary.path);
      return {
        ...summary,
        fileCount: aggregate.fileCount,
        dirCount: aggregate.dirCount,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
};

const describeMetaCell = (row: DisplayRow, lang: Lang): string => {
  if (isDirectorySummary(row)) {
    return lang === "zh"
      ? `${row.fileCount} 文件 / ${row.dirCount} 文件夹`
      : `${row.fileCount} files / ${row.dirCount} folders`;
  }
  return getSuffixTag(row);
};

const isOddSuffix = (suffix: string): boolean => {
  if (suffix === NO_EXT) return false;
  if (suffix.length > 24) return true;
  const segments = suffix.split(".").filter(Boolean);
  if (segments.length === 0 || segments.length > 3) return true;
  return segments.some((segment) => segment.length > 12 || !/^[a-z0-9_-]+$/i.test(segment) || /^\d{5,}$/i.test(segment));
};

const getMultiSuffix = (name: string): string => {
  const base = name.trim();
  if (!base) return NO_EXT;
  const firstDot = base.indexOf(".");
  if (firstDot <= 0) {
    return NO_EXT;
  }
  const suffix = base.slice(firstDot).toLowerCase();
  return isOddSuffix(suffix) ? ODD_EXT : suffix;
};

const getSuffixTag = (row: ScanRow): string => getMultiSuffix(getDisplayName(row));

const wildcardToRegExp = (pattern: string): RegExp => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
};

const tokenToMatcher = (token: string): ((row: ScanRow) => boolean) => {
  const trimmed = token.trim();
  if (!trimmed) {
    return () => true;
  }

  const regexMatch = trimmed.match(/^\/(.*)\/([gimsuy]*)$/);
  if (regexMatch) {
    try {
      const re = new RegExp(regexMatch[1], regexMatch[2]);
      return (row) => re.test(`${row.path} ${getDisplayName(row)} ${getSuffixTag(row)}`);
    } catch {
      return () => false;
    }
  }

  if (trimmed.includes("*") || trimmed.includes("?")) {
    const wildcard = wildcardToRegExp(trimmed.toLowerCase());
    return (row) => wildcard.test(row.path.toLowerCase()) || wildcard.test(getDisplayName(row).toLowerCase()) || wildcard.test(getSuffixTag(row));
  }

  if (trimmed.startsWith(".")) {
    const wanted = trimmed.toLowerCase();
    return (row) => getSuffixTag(row) === wanted;
  }

  const lower = trimmed.toLowerCase();
  return (row) => `${row.path} ${getDisplayName(row)} ${getSuffixTag(row)}`.toLowerCase().includes(lower);
};

const tokenizeSearchInput = (input: string): string[] => {
  const tokens: string[] = [];
  let index = 0;

  const pushToken = (token: string) => {
    const trimmed = token.trim();
    if (trimmed) {
      tokens.push(trimmed);
    }
  };

  while (index < input.length) {
    const char = input[index];
    if (/[\s,;|]/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "/") {
      let cursor = index + 1;
      let escaped = false;
      let closed = false;
      while (cursor < input.length) {
        const current = input[cursor];
        if (!escaped && current === "/") {
          closed = true;
          cursor += 1;
          while (cursor < input.length && /[gimsuy]/.test(input[cursor])) {
            cursor += 1;
          }
          break;
        }
        escaped = !escaped && current === "\\";
        if (current !== "\\") {
          escaped = false;
        }
        cursor += 1;
      }

      if (!closed) {
        cursor = index + 1;
        while (cursor < input.length && !/[\s,;|]/.test(input[cursor])) {
          cursor += 1;
        }
      }

      pushToken(input.slice(index, cursor));
      index = cursor;
      continue;
    }

    let cursor = index + 1;
    while (cursor < input.length && !/[\s,;|]/.test(input[cursor])) {
      cursor += 1;
    }
    pushToken(input.slice(index, cursor));
    index = cursor;
  }

  return tokens;
};

const buildSearchMatchers = (input: string): Array<(row: ScanRow) => boolean> =>
  tokenizeSearchInput(input)
    .map((token) => token.trim())
    .filter(Boolean)
    .map(tokenToMatcher);

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
};

const formatDateValue = (stamp: Date, dateFormat: DateFormat): string => {
  const year = String(stamp.getFullYear());
  const month = String(stamp.getMonth() + 1).padStart(2, "0");
  const day = String(stamp.getDate()).padStart(2, "0");
  if (dateFormat === "mdy") return `${month}/${day}/${year}`;
  if (dateFormat === "dmy") return `${day}/${month}/${year}`;
  return `${year}/${month}/${day}`;
};

const formatDate = (ms: number | undefined, lang: Lang, timeFormat: TimeFormat, dateFormat: DateFormat): string => {
  if (!ms) return "-";
  const parts = formatDateParts(ms, lang, timeFormat, dateFormat);
  return parts.time ? `${parts.date} ${parts.time}` : parts.date;
};

const formatDateParts = (
  ms: number | undefined,
  lang: Lang,
  timeFormat: TimeFormat,
  dateFormat: DateFormat,
): { date: string; time: string } => {
  if (!ms) {
    return { date: "-", time: "" };
  }

  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: timeFormat === "ampm",
  });
  const stamp = new Date(ms);
  const date = formatDateValue(stamp, dateFormat);
  const time = timeFormatter.format(stamp);
  return { date, time };
};

const formatCompactBytes = (bytes: number): string => formatBytes(bytes).replace(/\s+/g, "");

const deriveKind = (row: ScanRow): string => {
  const lower = `${row.path} ${row.name ?? ""}`.toLowerCase();
  if (/(cache|temp|thumb|thumbcache)/.test(lower)) return "cache-like";
  if (/\.(zip|rar|7z|tar|gz|bz2)$/i.test(row.ext ?? row.path)) return "archive";
  if (/\.(mp4|mkv|mov|avi|webm)$/i.test(row.ext ?? row.path)) return "video";
  if (/\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(row.ext ?? row.path)) return "image";
  if (/\.(html|htm|css|js|ts|tsx|json|md|txt)$/i.test(row.ext ?? row.path)) return "document";
  return "other";
};

const toBundle = (data: unknown): ScanBundleView => {
  if (Array.isArray(data)) {
    return {
      records: data as ScanRow[],
      duplicateGroups: [],
      riskFlags: [],
    };
  }

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const config = obj.config && typeof obj.config === "object" ? (obj.config as { roots?: string[] }) : undefined;
    const records = Array.isArray(obj.records) ? (obj.records as ScanRow[]) : [];
    const duplicateGroups = Array.isArray(obj.duplicateGroups)
      ? (obj.duplicateGroups as DuplicateGroupView[])
      : [];
    const riskFlags = Array.isArray(obj.riskFlags) ? (obj.riskFlags as RiskFlagView[]) : [];
    return { config, records, duplicateGroups, riskFlags };
  }

  return { records: [], duplicateGroups: [], riskFlags: [] };
};

let apiSessionToken = "";

const loadJson = async (source: string): Promise<ScanBundleView> => {
  const response = await fetch(source);
  if (!response.ok) {
    throw new Error(`Failed to load ${source}: ${response.status}`);
  }
  return toBundle(await response.json());
};

const loadTasksFromApi = async (): Promise<TaskSummaryView[]> => {
  const response = await fetch("/api/tasks");
  if (!response.ok) {
    throw new Error(`Failed to load tasks: ${response.status}`);
  }
  const payload = (await response.json()) as { tasks?: TaskSummaryView[] };
  return Array.isArray(payload.tasks) ? payload.tasks : [];
};

const loadSessionTokenFromApi = async (): Promise<string> => {
  const response = await fetch("/api/session");
  if (!response.ok) {
    throw new Error(`Failed to load API session token: ${response.status}`);
  }
  const payload = (await response.json()) as { token?: string };
  const token = String(payload.token ?? "").trim();
  if (!token) {
    throw new Error("API session token is empty");
  }
  return token;
};

const loadTaskBundleFromApi = async (taskId: string): Promise<ScanBundleView> => {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/bundle`);
  if (!response.ok) {
    throw new Error(`Failed to load task bundle: ${response.status}`);
  }
  return toBundle(await response.json());
};

const startScanFromApi = async (root: string): Promise<{ taskId: string; status: LiveScanStatusView }> => {
  const response = await fetch("/api/scan/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ roots: [root] }),
  });

  if (!response.ok) {
    throw new Error(`Failed to start scan: ${response.status}`);
  }

  const payload = (await response.json()) as {
    taskId: string;
    status: LiveScanStatusView;
  };
  return payload;
};

const getLiveScanStatusFromApi = async (taskId: string): Promise<LiveScanStatusPayload> => {
  const response = await fetch(`/api/scan/${encodeURIComponent(taskId)}/status`);
  if (!response.ok) {
    throw new Error(`Failed to load scan status: ${response.status}`);
  }
  return (await response.json()) as LiveScanStatusPayload;
};

const getLiveScanRecordsFromApi = async (
  taskId: string,
  from: number,
): Promise<{ nextFrom: number; records: ScanRow[] }> => {
  const response = await fetch(`/api/scan/${encodeURIComponent(taskId)}/records?from=${from}&limit=500`);
  if (!response.ok) {
    throw new Error(`Failed to load scan records: ${response.status}`);
  }
  const payload = (await response.json()) as {
    nextFrom: number;
    records: ScanRow[];
  };
  return {
    nextFrom: payload.nextFrom,
    records: payload.records ?? [],
  };
};

const pauseLiveScanFromApi = async (taskId: string): Promise<void> => {
  await postJson(`/api/scan/${encodeURIComponent(taskId)}/pause`, {});
};

const cancelLiveScanFromApi = async (taskId: string): Promise<void> => {
  await postJson(`/api/scan/${encodeURIComponent(taskId)}/cancel`, {});
};

const postJson = async <T,>(url: string, payload: unknown): Promise<T> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-DiskOrg-Client": "atlas-ui",
  };
  if (apiSessionToken) {
    headers["X-DiskOrg-Token"] = apiSessionToken;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      detail = body.error || body.message || "";
    } catch {
      // ignore non-json error body
    }
    throw new Error(`Request failed ${response.status}: ${url}${detail ? ` (${detail})` : ""}`);
  }
  return (await response.json()) as T;
};

const formatUiError = (error: unknown, lang: Lang): string => {
  const raw = error instanceof Error ? error.message : String(error);
  if (/ffmpeg_not_found/i.test(raw)) {
    return lang === "zh"
      ? "未检测到 ffmpeg。视频/图片压缩属于可选功能，请先安装 ffmpeg 并将其加入 PATH 后重试。Windows 可用 winget/choco，Linux 可用 apt/yum/pacman。"
      : "ffmpeg not found. Video/image compression is optional. Install ffmpeg and add it to PATH, then retry. Use winget/choco on Windows or apt/yum/pacman on Linux.";
  }
  if (/ghostscript_not_found/i.test(raw)) {
    return lang === "zh"
      ? "未检测到 Ghostscript。PDF 压缩属于可选功能，请先安装 Ghostscript 并将其加入 PATH 后重试。Windows 常见命令为 gswin64c，Linux 通常为 gs。"
      : "Ghostscript not found. PDF compression is optional. Install Ghostscript and add it to PATH, then retry. Typical command is gswin64c on Windows and gs on Linux.";
  }
  if (/tar_not_found/i.test(raw)) {
    return lang === "zh"
      ? "未检测到 tar。该打包功能属于可选能力，请安装 tar 后重试。"
      : "tar not found. This archive mode is optional. Install tar and try again.";
  }
  if (/failed to fetch|networkerror|load failed|econnrefused|econnreset/i.test(raw)) {
    return lang === "zh"
      ? "无法连接扫描 API（127.0.0.1:5174）。请先启动 npm run dev:api。"
      : "Cannot reach scan API (127.0.0.1:5174). Start npm run dev:api first.";
  }
  if (/copy_clipboard_linux_tool_missing/i.test(raw)) {
    return lang === "zh"
      ? "Linux 剪贴板复制需要 wl-copy、xclip 或 xsel 之一。请先安装其中一个。"
      : "Linux clipboard copy requires one of wl-copy, xclip, or xsel. Install one of them first.";
  }
  if (/copy_clipboard_unsupported_platform/i.test(raw)) {
    return lang === "zh"
      ? "当前平台暂不支持文件剪贴板复制。"
      : "File clipboard copy is not supported on this platform yet.";
  }
  if (/llm_openai_failed_401|llm_openai_failed_403/i.test(raw)) {
    return lang === "zh"
      ? "LLM 鉴权失败，请检查 API Key。"
      : "LLM authentication failed. Check your API key.";
  }
  if (/llm_openai_failed|llm_ollama_failed/i.test(raw)) {
    return lang === "zh"
      ? "LLM 请求失败，请检查 Base URL、模型名称和服务状态。"
      : "LLM request failed. Check base URL, model name, and service status.";
  }
  if (/Request failed 404:\s*\/api\/insight\/(analyze|settings)/i.test(raw)) {
    return lang === "zh"
      ? "当前 API 进程缺少智能识别路由（/api/insight/*）。请重启到最新后端代码后再试。"
      : "Current API process does not include insight routes (/api/insight/*). Restart the backend with the latest code and try again.";
  }
  if (/unauthorized_token|unauthorized_client|forbidden_origin/i.test(raw)) {
    return lang === "zh"
      ? "当前请求未通过本地安全校验。请刷新页面并确认正在访问本机页面。"
      : "The request failed local security checks. Refresh the page and ensure you are using a local page.";
  }
  if (/path_outside_scanned_roots/i.test(raw)) {
    return lang === "zh"
      ? "目标路径不在最近扫描根目录范围内，已阻止操作。"
      : "Target paths are outside the latest scanned roots, so the operation was blocked.";
  }
  if (/no_authorized_roots/i.test(raw)) {
    return lang === "zh"
      ? "尚未发现可授权的扫描根目录。请先执行一次扫描。"
      : "No authorized scan roots found yet. Run a scan first.";
  }
  return raw;
};

type DeleteApiResult = {
  deleted: string[];
  failed: Array<{ path: string; message: string }>;
};

const deleteFilesFromApi = async (paths: string[]): Promise<DeleteApiResult> => {
  if (paths.length === 0) return { deleted: [], failed: [] };
  const payload = await postJson<{ deleted?: string[]; failed?: Array<{ path: string; message: string }> }>(
    "/api/delete-files",
    { paths },
  );
  return {
    deleted: payload.deleted ?? [],
    failed: payload.failed ?? [],
  };
};

const deleteDirsFromApi = async (paths: string[]): Promise<DeleteApiResult> => {
  if (paths.length === 0) return { deleted: [], failed: [] };
  const payload = await postJson<{ deleted?: string[]; failed?: Array<{ path: string; message: string }> }>(
    "/api/delete-directories",
    { paths },
  );
  return {
    deleted: payload.deleted ?? [],
    failed: payload.failed ?? [],
  };
};

const copyItemsToApi = async (paths: string[]): Promise<string[]> => {
  if (paths.length === 0) return [];
  const payload = await postJson<{ copied?: string[] }>("/api/copy-items", { paths });
  return payload.copied ?? [];
};

const loadInsightSettingsFromApi = async (): Promise<InsightSettingsPayload> => {
  const response = await fetch("/api/insight/settings");
  if (!response.ok) {
    throw new Error(`Failed to load insight settings: ${response.status}`);
  }
  return (await response.json()) as InsightSettingsPayload;
};

const saveInsightSettingsToApi = async (
  settings: InsightSettingsPayload,
): Promise<InsightSettingsPayload> => postJson<InsightSettingsPayload>("/api/insight/settings", settings);

const loadRetentionSettingsFromApi = async (): Promise<RetentionSettingsPayload> => {
  const response = await fetch("/api/retention/settings");
  if (!response.ok) {
    throw new Error(`Failed to load retention settings: ${response.status}`);
  }
  return (await response.json()) as RetentionSettingsPayload;
};

const saveRetentionSettingsToApi = async (
  settings: RetentionSettingsPayload,
): Promise<RetentionSettingsPayload> => postJson<RetentionSettingsPayload>("/api/retention/settings", settings);

const runCompressionFromApi = async (
  payload: CompressionRequestPayload,
): Promise<CompressionResultPayload> => postJson<CompressionResultPayload>("/api/compress/run", payload);

const runCompressionBatchFromApi = async (
  payload: CompressionBatchRequestPayload,
): Promise<CompressionBatchResultPayload> => postJson<CompressionBatchResultPayload>("/api/compress/batch", payload);

const analyzeItemsInsightFromApi = async (
  items: Array<Pick<DisplayRow, "path" | "name" | "ext" | "size" | "isDir" | "mtimeMs" | "scanStatus">>,
  lang: Lang,
): Promise<InsightResultPayload> => postJson<InsightResultPayload>("/api/insight/analyze", { items, lang });

export function App() {
  const defaultSource = "/sample-data/demo_true_duplicates_bundle.json";
  const demoSandbox = useMemo(() => new URLSearchParams(window.location.search).has("demoSandbox"), []);
  const [lang, setLang] = useState<Lang>("zh");
  const [state, setState] = useState<LoadedState>({ kind: "loading" });
  const [apiMode, setApiMode] = useState(false);
  const [apiError, setApiError] = useState("");
  const [toastMessage, setToastMessage] = useState("");
  const [scanRoot, setScanRoot] = useState("D:/");
  const [scanBusy, setScanBusy] = useState(false);
  const [insightSettings, setInsightSettings] = useState<InsightSettingsPayload>({
    provider: "disabled",
    baseUrl: "http://127.0.0.1:11434",
    model: "",
    apiKey: "",
    webSearchEnabled: true,
    temperature: 0.2,
  });
  const [insightEnabled, setInsightEnabled] = useState(false);
  const [insightSaving, setInsightSaving] = useState(false);
  const [insightLoading, setInsightLoading] = useState(false);
  const [insightResult, setInsightResult] = useState<InsightResultPayload | null>(null);
  const [insightError, setInsightError] = useState("");
  const [footerTab, setFooterTab] = useState<FooterTab>("compress");
  const [compressionMode, setCompressionMode] = useState<CompressionMode>("video");
  const [compressOutputPath, setCompressOutputPath] = useState("");
  const [compressOutputDir, setCompressOutputDir] = useState("");
  const [videoPreset, setVideoPreset] = useState<VideoPreset>("balanced_1080p");
  const [videoFormat, setVideoFormat] = useState<VideoFormat>("mp4");
  const [videoBitrateMode, setVideoBitrateMode] = useState<VideoBitrateMode>("dynamic");
  const [videoBitrateKbps, setVideoBitrateKbps] = useState(4500);
  const [videoResolution, setVideoResolution] = useState<VideoResolution>("keep");
  const [videoFrameRate, setVideoFrameRate] = useState<VideoFrameRate>("keep");
  const [imageStrategy, setImageStrategy] = useState<"keep_resolution" | "resize_and_compress">("keep_resolution");
  const [imageQuality, setImageQuality] = useState(82);
  const [imageMaxWidth, setImageMaxWidth] = useState(1920);
  const [imageMaxHeight, setImageMaxHeight] = useState(1080);
  const [pdfPreset, setPdfPreset] = useState<"screen" | "ebook" | "printer">("ebook");
  const [pdfTargetSizeMb, setPdfTargetSizeMb] = useState(0);
  const [packageStoreOnly, setPackageStoreOnly] = useState(true);
  const [packageFormat, setPackageFormat] = useState<CompressionArchiveFormat>("zip");
  const [compressionRunning, setCompressionRunning] = useState(false);
  const [compressionError, setCompressionError] = useState("");
  const [compressionResult, setCompressionResult] = useState<CompressionResultPayload | null>(null);
  const [compressionBatchResult, setCompressionBatchResult] = useState<CompressionBatchResultPayload | null>(null);
  const [retentionSettings, setRetentionSettings] = useState<RetentionSettingsPayload>({
    enabled: true,
    keepBundleDays: 14,
    maxBundleFiles: 20,
    keepTaskDays: 30,
    keepAnalysisCacheDays: 90,
  });
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionError, setRetentionError] = useState("");
  const [timeFormat, setTimeFormat] = useState<TimeFormat>("24h");
  const [dateFormat, setDateFormat] = useState<DateFormat>("ymd");
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [includedSuffixes, setIncludedSuffixes] = useState<string[]>([]);
  const [excludedSuffixes, setExcludedSuffixes] = useState<string[]>([]);
  const [selectedRiskKinds, setSelectedRiskKinds] = useState<string[]>([]);
  const [minSizeValue, setMinSizeValue] = useState("");
  const [minSizeUnit, setMinSizeUnit] = useState<Unit>("MB");
  const [maxSizeValue, setMaxSizeValue] = useState("");
  const [maxSizeUnit, setMaxSizeUnit] = useState<Unit>("GB");
  const [sortBy, setSortBy] = useState<SortKey | null>("size");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [showFiles, setShowFiles] = useState(true);
  const [showDirectories, setShowDirectories] = useState(true);
  const [selectedDuplicateGroupId, setSelectedDuplicateGroupId] = useState<string | null>(null);
  const [liveTaskId, setLiveTaskId] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveScanStatusView | null>(null);
  const [livePhase, setLivePhase] = useState<LiveScanPhaseView | null>(null);
  const [livePhaseProgress, setLivePhaseProgress] = useState<{
    stage: "indexing" | "quick_hash" | "full_hash";
    completed: number;
    total: number;
  } | null>(null);
  const [liveElapsedMs, setLiveElapsedMs] = useState(0);
  const [liveStats, setLiveStats] = useState<LiveScanStatsView | null>(null);
  const [lastIndexedAt, setLastIndexedAt] = useState<string | null>(null);
  const [recordCursor, setRecordCursor] = useState(0);
  const [showAllSuffixes, setShowAllSuffixes] = useState(false);
  const [tableStartIndex, setTableStartIndex] = useState(0);
  const [tableViewportHeight, setTableViewportHeight] = useState(520);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);

  const tipText = {
    scanPath: lang === "zh" ? "输入你想扫描的根目录。目录汇总和文件结果都只在这个范围内生成。" : "Choose the root folder to scan. File and directory results stay scoped to this range.",
    scanStatus: lang === "zh" ? "显示当前扫描进度、已扫描文件数、耗时，以及卡顿迹象。" : "Shows current scan progress, indexed file count, elapsed time, and possible stalls.",
    search: lang === "zh" ? "支持关键字、通配符和正则，例如 report、*.psd、/猫|dog/i。" : "Supports keywords, wildcards, and regex such as report, *.psd, or /cat|dog/i.",
    suffix: lang === "zh" ? "根据后缀快速筛选。左键包含，右键或长按排除。异常长或混乱后缀会被归到 odd-ext。" : "Filter quickly by suffix. Left-click includes, right-click or long press excludes. Noisy suffixes are grouped into odd-ext.",
    minSize: lang === "zh" ? "只保留大于等于该大小的项目。" : "Keep only items greater than or equal to this size.",
    maxSize: lang === "zh" ? "只保留小于等于该大小的项目。" : "Keep only items smaller than or equal to this size.",
    risk: lang === "zh" ? "这里汇总扫描过程中发现的风险类型，例如不可读、加密或离线占位文件。" : "Summarizes risk types discovered during scanning, such as unreadable, encrypted, or offline placeholder items.",
    duplicates: lang === "zh" ? "只把完整内容一致的文件归为一组。点击某组后，主列表只显示这一组的重复文件。" : "Groups only files whose full contents match. Selecting a group focuses the main list on that duplicate set.",
  };

  const showToast = (message: string) => {
    setToastMessage(message);
  };

  useEffect(() => {
    if (!toastMessage) {
      return;
    }
    const timer = window.setTimeout(() => setToastMessage(""), 3600);
    return () => {
      window.clearTimeout(timer);
    };
  }, [toastMessage]);

  useEffect(() => {
    const bootstrap = async () => {
      if (demoSandbox) {
        apiSessionToken = "";
        setApiMode(false);
        setApiError("Demo sandbox mode (read-only)");
        setInsightEnabled(false);
        try {
          const bundle = await loadJson(defaultSource);
          setState({ kind: "ready", bundle });
        } catch (error) {
          setState({ kind: "error", message: (error as Error).message });
        }
        return;
      }

      try {
        const taskList = await loadTasksFromApi();
        try {
          apiSessionToken = await loadSessionTokenFromApi();
        } catch {
          apiSessionToken = "";
        }
        setApiMode(true);
        setApiError("");

        try {
          const settings = await loadInsightSettingsFromApi();
          setInsightEnabled(settings.provider !== "disabled");
          setInsightSettings({
            ...settings,
            provider: settings.provider === "disabled" ? "ollama" : settings.provider,
          });
        } catch {
          // Keep API mode enabled even if optional insight settings endpoint is unavailable.
          setInsightEnabled(false);
        }

        try {
          const retention = await loadRetentionSettingsFromApi();
          setRetentionSettings(retention);
        } catch {
          // Keep defaults when retention endpoint is unavailable.
        }

        if (taskList.length > 0) {
          const latest = taskList[0];
          const latestBundle = await loadTaskBundleFromApi(latest.id);
          setState({ kind: "ready", bundle: latestBundle });
        } else {
          const bundle = await loadJson(defaultSource);
          setState({ kind: "ready", bundle });
        }
      } catch {
        apiSessionToken = "";
        setApiMode(false);
        setApiError("API unavailable (fallback to sample/import mode)");
        try {
          const bundle = await loadJson(defaultSource);
          setState({ kind: "ready", bundle });
        } catch (error) {
          setState({ kind: "error", message: (error as Error).message });
        }
      }
    };

    bootstrap();
  }, [defaultSource, demoSandbox]);

  useEffect(() => {
    if (!liveTaskId) {
      return;
    }

    let disposed = false;

    const sync = async () => {
      try {
        const status = await getLiveScanStatusFromApi(liveTaskId);
        if (disposed) return;

        setLiveStatus(status.status);
        setLivePhase(status.phase ?? null);
        setLivePhaseProgress(status.phaseProgress ?? null);
        setLiveElapsedMs(status.elapsedMs);
        setLiveStats(status.stats);
        setLastIndexedAt(status.lastIndexedAt);

        if (status.totalRecords > recordCursor) {
          const chunk = await getLiveScanRecordsFromApi(liveTaskId, recordCursor);
          if (disposed) return;
          setRecordCursor(chunk.nextFrom);
          if (chunk.records.length > 0) {
            setState((current) => {
              if (current.kind !== "ready") {
                return current;
              }
              return {
                ...current,
                bundle: {
                  ...current.bundle,
                  records: [...current.bundle.records, ...chunk.records],
                },
              };
            });
          }
        }

        setState((current) => {
          if (current.kind !== "ready") {
            return current;
          }
          return {
            ...current,
            bundle: {
              ...current.bundle,
              duplicateGroups: status.duplicateGroups,
              riskFlags: status.riskFlags,
            },
          };
        });

        if (status.status === "finished") {
          setScanBusy(false);
          showToast(`${t(lang, "scanDone")}: ${status.taskId}`);
        }

        if (status.status === "paused") {
          setScanBusy(false);
          showToast(lang === "zh" ? "扫描已暂停，仅保留已扫描内容。" : "Scan paused. Showing scanned content only.");
        }

        if (status.status === "cancelled") {
          setScanBusy(false);
          setState((current) =>
            current.kind === "ready"
              ? { kind: "ready", bundle: createEmptyBundle(current.bundle.config?.roots ?? []) }
              : { kind: "ready", bundle: createEmptyBundle() },
          );
          setSelectedRows([]);
          setSelectedPath(null);
          showToast(lang === "zh" ? "扫描已取消，列表已清空。" : "Scan cancelled. List cleared.");
        }

        if (status.status === "failed") {
          setScanBusy(false);
          setApiError(status.error ?? (lang === "zh" ? "扫描失败" : "Scan failed"));
        }
      } catch (error) {
        if (disposed) return;
        setScanBusy(false);
        setLiveStatus("failed");
        setApiError(formatUiError(error, lang));
      }
    };

    void sync();
    const timer = window.setInterval(() => {
      void sync();
    }, 1000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [liveTaskId, recordCursor, lang]);

  const startScan = async () => {
    const root = scanRoot.trim();
    if (!root || scanBusy) {
      return;
    }

    setScanBusy(true);
    setApiError("");
    try {
      const payload = await startScanFromApi(root);
      setLiveTaskId(payload.taskId);
      setLiveStatus(payload.status);
      setLivePhase("indexing");
      setLivePhaseProgress({ stage: "indexing", completed: 0, total: 0 });
      setLiveElapsedMs(0);
      setLiveStats(null);
      setLastIndexedAt(null);
      setRecordCursor(0);
      setState({ kind: "ready", bundle: createEmptyBundle([root]) });
      setSelectedRiskKinds([]);
      setSelectedRows([]);
      setSelectedPath(null);
      showToast(lang === "zh" ? `扫描已启动：${payload.taskId}` : `Scan started: ${payload.taskId}`);
    } catch (error) {
      setLiveStatus("failed");
      setApiError(formatUiError(error, lang));
      setScanBusy(false);
    }
  };

  const pauseScan = async () => {
    if (!liveTaskId || !scanBusy) {
      return;
    }
    try {
      await pauseLiveScanFromApi(liveTaskId);
      showToast(lang === "zh" ? "暂停请求已发送。" : "Pause request sent.");
    } catch (error) {
      setApiError(formatUiError(error, lang));
    }
  };

  const cancelScan = async () => {
    if (!liveTaskId || !scanBusy) {
      return;
    }
    try {
      await cancelLiveScanFromApi(liveTaskId);
      setScanBusy(false);
      setLiveStatus("cancelled");
      setLivePhase("finished");
      setState((current) =>
        current.kind === "ready"
          ? { kind: "ready", bundle: createEmptyBundle(current.bundle.config?.roots ?? []) }
          : { kind: "ready", bundle: createEmptyBundle() },
      );
      setRecordCursor(0);
      setSelectedRows([]);
      setSelectedPath(null);
      showToast(lang === "zh" ? "扫描已取消，列表已清空。" : "Scan cancelled. List cleared.");
    } catch (error) {
      setApiError(formatUiError(error, lang));
    }
  };

  const bundle =
    state.kind === "ready"
      ? state.bundle
      : ({ records: [], duplicateGroups: [], riskFlags: [] } as ScanBundleView);
  const fileRows = useMemo(
    () => bundle.records.map((row) => ({ ...row, itemType: "file" as const, isDir: false as const })),
    [bundle.records],
  );
  const directoryRows = useMemo(
    () => buildDirectorySummaries(bundle.records, bundle.config?.roots ?? []),
    [bundle.records, bundle.config?.roots],
  );
  const selectedDuplicateGroup = useMemo(
    () => bundle.duplicateGroups.find((group) => group.id === selectedDuplicateGroupId) ?? null,
    [bundle.duplicateGroups, selectedDuplicateGroupId],
  );
  const duplicateGroupPathSet = useMemo(
    () => new Set(selectedDuplicateGroup?.members.map((member) => member.path) ?? []),
    [selectedDuplicateGroup],
  );
  const duplicateGroupFilterActive = selectedDuplicateGroup !== null;
  const activeFileRows = useMemo(
    () =>
      duplicateGroupFilterActive
        ? fileRows.filter((row) => duplicateGroupPathSet.has(row.path))
        : fileRows,
    [duplicateGroupFilterActive, duplicateGroupPathSet, fileRows],
  );
  const activeDirectoryRows = useMemo(
    () =>
      duplicateGroupFilterActive
        ? buildDirectorySummaries(activeFileRows, bundle.config?.roots ?? [])
        : directoryRows,
    [duplicateGroupFilterActive, activeFileRows, bundle.config?.roots, directoryRows],
  );
  const rows = bundle.records;
  const suffixSummaries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of activeFileRows) {
      const suffix = getSuffixTag(row);
      counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
    }

    const collator = lang === "zh" ? zhPinyinCollator : enCollator;
    return [...counts.entries()]
      .map(([suffix, count]) => ({ suffix, count }))
      .sort((a, b) => {
        if (a.suffix === NO_EXT) return -1;
        if (b.suffix === NO_EXT) return 1;
        if (a.suffix === ODD_EXT) return 1;
        if (b.suffix === ODD_EXT) return -1;
        if (b.count !== a.count) return b.count - a.count;
        return collator.compare(a.suffix, b.suffix);
      });
  }, [activeFileRows, lang]);
  const suffixOptions = useMemo(() => suffixSummaries.map((item) => item.suffix), [suffixSummaries]);
  const visibleSuffixSummaries = useMemo(
    () => (showAllSuffixes ? suffixSummaries : suffixSummaries.slice(0, SUFFIX_VISIBLE_LIMIT)),
    [showAllSuffixes, suffixSummaries],
  );
  const hiddenSuffixCount = Math.max(0, suffixSummaries.length - visibleSuffixSummaries.length);

  const suffixFilterActive = includedSuffixes.length > 0 || excludedSuffixes.length > 0;
  const manualSearchActive = searchFocused || query.trim().length > 0;
  const searchDisabled = suffixFilterActive || duplicateGroupFilterActive;
  const suffixFilterDisabled = manualSearchActive || duplicateGroupFilterActive;
  const searchMatchers = useMemo(() => buildSearchMatchers(query), [query]);

  const minSizeBytes = useMemo(() => {
    if (minSizeValue.trim() === "") {
      return Number.NEGATIVE_INFINITY;
    }
    const value = Number(minSizeValue);
    return Number.isFinite(value) ? value * unitMap[minSizeUnit] : Number.NEGATIVE_INFINITY;
  }, [minSizeValue, minSizeUnit]);

  const maxSizeBytes = useMemo(() => {
    if (maxSizeValue.trim() === "") {
      return Number.POSITIVE_INFINITY;
    }
    const value = Number(maxSizeValue);
    return Number.isFinite(value) ? value * unitMap[maxSizeUnit] : Number.POSITIVE_INFINITY;
  }, [maxSizeValue, maxSizeUnit]);

  const filteredRows = useMemo(() => {
    const sourceRows: DisplayRow[] = duplicateGroupFilterActive
      ? [...activeFileRows]
      : [
          ...(showFiles ? activeFileRows : []),
          ...(showDirectories ? activeDirectoryRows : []),
        ];

    return [...sourceRows]
      .filter((row) => {
        if (duplicateGroupFilterActive) {
          return true;
        }
        const suffix = isDirectorySummary(row) ? NO_EXT : getSuffixTag(row);

        if (includedSuffixes.length > 0 && !includedSuffixes.includes(suffix)) {
          return false;
        }
        if (excludedSuffixes.includes(suffix)) {
          return false;
        }

        if (!suffixFilterActive && searchMatchers.length > 0 && !searchMatchers.some((matcher) => matcher(row))) {
          return false;
        }

        if (row.size < minSizeBytes) return false;
        if (row.size > maxSizeBytes) return false;
        return true;
      })
      .sort((a, b) => {
        if (!sortBy) {
          return 0;
        }
        const dir = sortDir === "asc" ? 1 : -1;
        const av = sortBy === "ext" ? describeMetaCell(a, lang) : (a[sortBy] ?? 0);
        const bv = sortBy === "ext" ? describeMetaCell(b, lang) : (b[sortBy] ?? 0);
        if (typeof av === "number" && typeof bv === "number") {
          return (av - bv) * dir;
        }
        const collator = lang === "zh" ? zhPinyinCollator : enCollator;
        return collator.compare(String(av), String(bv)) * dir;
      });
  }, [
    activeFileRows,
    activeDirectoryRows,
    showFiles,
    showDirectories,
    duplicateGroupFilterActive,
    includedSuffixes,
    excludedSuffixes,
    suffixFilterActive,
    searchMatchers,
    minSizeBytes,
    maxSizeBytes,
    sortBy,
    sortDir,
    lang,
  ]);

  useEffect(() => {
    if (!filteredRows.length) {
      setSelectedPath(null);
      return;
    }
    if (!selectedPath || !filteredRows.some((row) => row.path === selectedPath)) {
      setSelectedPath(filteredRows[0].path);
    }
  }, [filteredRows, selectedPath]);

  const selectedRow = filteredRows.find((row) => row.path === selectedPath) ?? null;

  const visibleRowRange = useMemo(() => {
    const start = Math.max(0, tableStartIndex);
    const visibleCount = Math.ceil(tableViewportHeight / TABLE_ROW_HEIGHT) + TABLE_OVERSCAN * 2;
    const end = Math.min(filteredRows.length, start + visibleCount);
    return { start, end };
  }, [filteredRows.length, tableStartIndex, tableViewportHeight]);

  const visibleRows = useMemo(
    () => filteredRows.slice(visibleRowRange.start, visibleRowRange.end),
    [filteredRows, visibleRowRange],
  );
  const topSpacerHeight = visibleRowRange.start * TABLE_ROW_HEIGHT;
  const bottomSpacerHeight = Math.max(0, (filteredRows.length - visibleRowRange.end) * TABLE_ROW_HEIGHT);

  const totalDisplayRows = useMemo(
    () => (showFiles ? fileRows.length : 0) + (showDirectories ? directoryRows.length : 0),
    [showFiles, fileRows.length, showDirectories, directoryRows.length],
  );

  const stats = useMemo(() => {
    const totalBytes = rows.reduce((sum, row) => sum + row.size, 0);
    const biggest = [...rows].sort((a, b) => b.size - a.size)[0];
    const kindCounts = rows.reduce<Record<string, number>>((acc, row) => {
      const kind = deriveKind(row);
      acc[kind] = (acc[kind] ?? 0) + 1;
      return acc;
    }, {});
    return {
      items: totalDisplayRows,
      files: fileRows.length,
      directories: directoryRows.length,
      filtered: filteredRows.length,
      totalBytes,
      biggest,
      kindCounts,
    };
  }, [rows, filteredRows, totalDisplayRows, fileRows.length, directoryRows.length]);

  const elapsedLabel = useMemo(() => {
    const totalSeconds = Math.floor(liveElapsedMs / 1000);
    const mm = Math.floor(totalSeconds / 60)
      .toString()
      .padStart(2, "0");
    const ss = (totalSeconds % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
  }, [liveElapsedMs]);

  const isPossiblyStuck = useMemo(() => {
    if (!scanBusy) return false;
    const anchor = lastIndexedAt ? Date.parse(lastIndexedAt) : Date.now();
    if (!Number.isFinite(anchor)) return false;
    return Date.now() - anchor > 20000;
  }, [scanBusy, lastIndexedAt, liveElapsedMs]);

  const trueDuplicateGroups = useMemo(
    () => [...bundle.duplicateGroups].sort((a, b) => b.memberCount - a.memberCount).slice(0, 8),
    [bundle.duplicateGroups],
  );

  const riskKinds = useMemo(
    () => [...new Set(bundle.riskFlags.map((risk) => risk.kind))].sort((a, b) => a.localeCompare(b)),
    [bundle.riskFlags],
  );

  const filteredRiskFlags = useMemo(() => {
    if (duplicateGroupFilterActive) {
      return [];
    }
    if (selectedRiskKinds.length === 0) {
      return bundle.riskFlags;
    }
    const set = new Set(selectedRiskKinds);
    return bundle.riskFlags.filter((risk) => set.has(risk.kind));
  }, [bundle.riskFlags, selectedRiskKinds]);

  const filteredPaths = useMemo(() => filteredRows.map((row) => row.path), [filteredRows]);
  const selectedSet = useMemo(() => new Set(selectedRows), [selectedRows]);
  const allSelected = filteredPaths.length > 0 && filteredPaths.every((path) => selectedSet.has(path));
  const partialSelected = !allSelected && filteredPaths.some((path) => selectedSet.has(path));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = partialSelected;
    }
  }, [partialSelected]);

  useEffect(() => {
    setTableStartIndex(0);
    if (tableWrapRef.current) {
      tableWrapRef.current.scrollTop = 0;
    }
  }, [query, includedSuffixes, excludedSuffixes, minSizeBytes, maxSizeBytes, sortBy, sortDir]);

  useEffect(() => {
    setShowAllSuffixes(false);
  }, [suffixSummaries.length]);

  useEffect(() => {
    const updateViewport = () => {
      if (!tableWrapRef.current) {
        return;
      }
      setTableViewportHeight(tableWrapRef.current.clientHeight || 520);
    };

    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
    };
  }, []);

  useEffect(() => {
    const pathSet = new Set(filteredRows.map((row) => row.path));
    setSelectedRows((current) => current.filter((path) => pathSet.has(path)));
  }, [filteredRows]);

  useEffect(() => {
    setInsightResult(null);
    setInsightError("");
  }, [selectedPath, selectedRows]);

  const toggleIncludedSuffix = (suffix: string) => {
    if (suffixFilterDisabled) return;
    setExcludedSuffixes((current) => current.filter((item) => item !== suffix));
    setIncludedSuffixes((current) =>
      current.includes(suffix) ? current.filter((item) => item !== suffix) : [...current, suffix],
    );
  };

  const toggleExcludedSuffix = (suffix: string) => {
    if (suffixFilterDisabled) return;
    setIncludedSuffixes((current) => current.filter((item) => item !== suffix));
    setExcludedSuffixes((current) =>
      current.includes(suffix) ? current.filter((item) => item !== suffix) : [...current, suffix],
    );
  };

  const clearSuffixFilters = () => {
    if (suffixFilterDisabled) return;
    setIncludedSuffixes([]);
    setExcludedSuffixes([]);
  };

  const applyDeletion = (removedFilePaths: string[], removedDirectories: string[]) => {
    const removedFileSet = new Set(removedFilePaths);
    const normalizedDirs = removedDirectories.map((dir) => dir.replace(/[\\/]+$/, ""));
    const shouldRemove = (filePath: string): boolean => {
      if (removedFileSet.has(filePath)) return true;
      return normalizedDirs.some((dir) => {
        if (!dir) return false;
        return filePath === dir || filePath.startsWith(`${dir}${filePath.includes("\\") ? "\\" : "/"}`) || filePath.startsWith(`${dir}/`) || filePath.startsWith(`${dir}\\`);
      });
    };

    setState((current) => {
      if (current.kind !== "ready") {
        return current;
      }

      const records = current.bundle.records.filter((row) => !shouldRemove(row.path));
      const recordPathSet = new Set(records.map((row) => row.path));

      const duplicateGroups = current.bundle.duplicateGroups
        .map((group) => {
          const members = group.members.filter((member) => recordPathSet.has(member.path));
          return {
            ...group,
            members,
            memberCount: members.length,
            totalSize: members.reduce((sum, member) => sum + member.size, 0),
          };
        })
        .filter((group) => group.memberCount >= 2);

      const riskFlags = current.bundle.riskFlags.filter((risk) => !shouldRemove(risk.filePath));

      return {
        ...current,
        bundle: {
          ...current.bundle,
          records,
          duplicateGroups,
          riskFlags,
        },
      };
    });

    setSelectedRows([]);
  };

  const removeSelectedItems = async () => {
    if (!apiMode) {
      setApiError(lang === "zh" ? "演示沙盒模式下不允许删除操作。" : "Delete is disabled in demo sandbox mode.");
      return;
    }
    if (selectedRows.length === 0) return;
    const selectedDisplayRows = filteredRows.filter((row) => selectedSet.has(row.path));
    const filePaths = selectedDisplayRows.filter((row) => !isDirectorySummary(row)).map((row) => row.path);
    const dirPaths = selectedDisplayRows.filter(isDirectorySummary).map((row) => row.path);
    const confirmed = window.confirm(
      lang === "zh"
        ? "确定永久删除所选项目吗？此操作不可恢复。"
        : "Delete selected items permanently? This action cannot be undone.",
    );
    if (!confirmed) return;

    try {
      const fileResult = await deleteFilesFromApi(filePaths);
      const dirResult = await deleteDirsFromApi(dirPaths);
      applyDeletion(fileResult.deleted, dirResult.deleted);
      const failures = [...fileResult.failed, ...dirResult.failed];
      if (failures.length > 0) {
        const first = failures[0];
        setApiError(
          lang === "zh"
            ? `已删除 ${fileResult.deleted.length + dirResult.deleted.length} 个，失败 ${failures.length} 个：${first.path} (${first.message})`
            : `Deleted ${fileResult.deleted.length + dirResult.deleted.length}, failed ${failures.length}: ${first.path} (${first.message})`,
        );
      } else {
        showToast(
          lang === "zh"
            ? `已删除 ${fileResult.deleted.length + dirResult.deleted.length} 个选中项`
            : `Deleted ${fileResult.deleted.length + dirResult.deleted.length} selected items`,
        );
      }
    } catch (error) {
      setApiError(error instanceof Error ? error.message : String(error));
    }
  };

  const copySelectedItems = async () => {
    if (!apiMode) {
      setApiError(lang === "zh" ? "演示沙盒模式下不允许复制到系统剪贴板。" : "Clipboard copy is disabled in demo sandbox mode.");
      return;
    }
    if (selectedRows.length === 0) return;
    const selectedDisplayRows = filteredRows.filter((row) => selectedSet.has(row.path));
    const paths = selectedDisplayRows.map((row) => row.path);
    try {
      const copied = await copyItemsToApi(paths);
      showToast(
        lang === "zh"
          ? `已复制 ${copied.length} 个选中项到系统剪贴板，可在资源管理器中粘贴。`
          : `Copied ${copied.length} selected items to the system clipboard. Paste in Explorer to extract them.`,
      );
    } catch (error) {
      setApiError(formatUiError(error, lang));
    }
  };

  const saveInsightSettings = async () => {
    try {
      setInsightSaving(true);
      setInsightError("");
      const payload: InsightSettingsPayload = {
        ...insightSettings,
        provider: insightEnabled ? insightSettings.provider : "disabled",
      };
      const saved = await saveInsightSettingsToApi(payload);
      setInsightEnabled(saved.provider !== "disabled");
      setInsightSettings({
        ...saved,
        provider: saved.provider === "disabled" ? insightSettings.provider : saved.provider,
      });
      showToast(lang === "zh" ? "智能识别配置已保存。" : "Insight settings saved.");
    } catch (error) {
      setInsightError(formatUiError(error, lang));
    } finally {
      setInsightSaving(false);
    }
  };

  const saveRetentionSettings = async () => {
    try {
      setRetentionSaving(true);
      setRetentionError("");
      const saved = await saveRetentionSettingsToApi(retentionSettings);
      setRetentionSettings(saved);
      showToast(lang === "zh" ? "自动清理策略已保存。" : "Retention settings saved.");
    } catch (error) {
      setRetentionError(formatUiError(error, lang));
    } finally {
      setRetentionSaving(false);
    }
  };

  const runCompressionJob = async () => {
    if (!apiMode) {
      setCompressionError(lang === "zh" ? "演示沙盒模式下不执行真实压缩/打包。" : "Compression/package is disabled in demo sandbox mode.");
      return;
    }
    const selectedDisplayRows = filteredRows.filter((row) => selectedSet.has(row.path));
    const selectedTargets = selectedDisplayRows.map((row) => row.path);
    const targets = selectedTargets;

    if (targets.length === 0) {
      setCompressionError(lang === "zh" ? "请先在上方列表选择要处理的文件或目录。" : "Please select files or folders in the upper list first.");
      return;
    }

    try {
      setCompressionRunning(true);
      setCompressionError("");
      setCompressionResult(null);
      setCompressionBatchResult(null);

      if (compressionMode === "video") {
        const batchPayload: CompressionBatchRequestPayload = {
          mode: "video",
          inputPaths: targets,
          outputDir: compressOutputDir.trim() || undefined,
          videoPreset,
          videoFormat: videoPreset === "manual" ? videoFormat : undefined,
          videoBitrateMode: videoPreset === "manual" ? videoBitrateMode : undefined,
          videoBitrateKbps: videoPreset === "manual" ? Math.max(200, Math.trunc(videoBitrateKbps)) : undefined,
          videoResolution: videoPreset === "manual" ? videoResolution : undefined,
          videoFrameRate: videoPreset === "manual" ? videoFrameRate : undefined,
        };
        const batchResult = await runCompressionBatchFromApi(batchPayload);
        setCompressionBatchResult(batchResult);
      } else if (compressionMode === "package") {
        const batchPayload: CompressionBatchRequestPayload = {
          mode: "package",
          inputPaths: targets,
          outputPath: compressOutputPath.trim() || undefined,
          packageFormat,
          packageStoreOnly,
        };
        const batchResult = await runCompressionBatchFromApi(batchPayload);
        setCompressionBatchResult(batchResult);
      } else {
        if (targets.length > 1) {
          setCompressionError(lang === "zh" ? "图片/PDF 目前为单文件模式，请只选择一个目标。" : "Image/PDF currently supports single-file mode. Please select one target.");
          return;
        }

        const payload: CompressionRequestPayload = {
          mode: compressionMode,
          inputPath: targets[0],
          outputPath: compressOutputPath.trim() || undefined,
          imageStrategy,
          imageQuality,
          maxWidth: imageMaxWidth,
          maxHeight: imageMaxHeight,
          pdfPreset,
          targetSizeMb: pdfTargetSizeMb > 0 ? pdfTargetSizeMb : undefined,
          packageStoreOnly,
        };
        const result = await runCompressionFromApi(payload);
        setCompressionResult(result);
      }

      showToast(lang === "zh" ? "压缩/打包任务完成。" : "Compression/package task finished.");
    } catch (error) {
      setCompressionError(formatUiError(error, lang));
    } finally {
      setCompressionRunning(false);
    }
  };

  const explainSelectedItems = async () => {
    const selectedDisplayRows = filteredRows.filter((row) => selectedSet.has(row.path));
    const targets = selectedDisplayRows.length > 0
      ? selectedDisplayRows
      : (selectedRow ? [selectedRow] : []);

    if (targets.length === 0) {
      return;
    }

    if (demoSandbox) {
      setInsightError("");
      setInsightResult({
        summary: lang === "zh"
          ? "这是演示沙盒结果：该目标看起来像可归档的普通文件集合。"
          : "Demo sandbox result: this target looks like a regular, archivable file set.",
        deletableAdvice: "caution",
        confidence: "medium",
        impact: lang === "zh"
          ? "删除前建议先做归档备份。"
          : "Archive a backup before deletion.",
        reasons: [
          lang === "zh" ? "演示模式不访问真实文件内容。" : "Demo mode does not read real file contents.",
          lang === "zh" ? "结论仅用于交互展示。" : "Conclusion is for interaction showcase only.",
        ],
        sourceHints: ["demo_sandbox"],
        searchEvidence: [],
        provider: "disabled",
        model: null,
      });
      return;
    }

    try {
      setInsightLoading(true);
      setInsightError("");
      const result = await analyzeItemsInsightFromApi(
        targets.map((row) => ({
          path: row.path,
          name: getDisplayName(row),
          ext: row.ext ?? "",
          size: row.size,
          isDir: isDirectorySummary(row),
          mtimeMs: row.mtimeMs,
          scanStatus: row.scanStatus,
        })),
        lang,
      );
      setInsightResult(result);
    } catch (error) {
      setInsightError(formatUiError(error, lang));
    } finally {
      setInsightLoading(false);
    }
  };

  const toggleRowSelection = (rowPath: string) => {
    setSelectedRows((current) =>
      current.includes(rowPath) ? current.filter((item) => item !== rowPath) : [...current, rowPath],
    );
  };

  const toggleSelectAllVisible = () => {
    if (allSelected) {
      setSelectedRows((current) => current.filter((path) => !filteredPaths.includes(path)));
      return;
    }
    setSelectedRows((current) => [...new Set([...current, ...filteredPaths])]);
  };

  const handleSuffixPointerDown = (event: React.PointerEvent<HTMLButtonElement>, suffix: string) => {
    if (event.pointerType !== "touch") return;
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      toggleExcludedSuffix(suffix);
    }, 550);
  };

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const toggleRiskKind = (kind: string) => {
    if (duplicateGroupFilterActive) {
      return;
    }
    setSelectedRiskKinds((current) =>
      current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind],
    );
  };

  const toggleDuplicateGroupFilter = (groupId: string) => {
    setSelectedDuplicateGroupId((current) => (current === groupId ? null : groupId));
  };

  const cycleSort = (nextKey: SortKey) => {
    if (sortBy !== nextKey) {
      setSortBy(nextKey);
      setSortDir("desc");
      return;
    }

    if (sortDir === "desc") {
      setSortDir("asc");
      return;
    }

    setSortBy(null);
  };

  const sortIndicator = (key: SortKey): string => {
    if (sortBy !== key) {
      return "";
    }
    return sortDir === "desc" ? " ↓" : " ↑";
  };

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">{lang === "zh" ? "磁盘整理控制面板" : "Disk Organizer Control Panel"}</p>
          <h1>{t(lang, "title")}</h1>
          <p className="lede">{t(lang, "subtitle")}</p>
          {apiError ? <p className="muted">{apiError}</p> : null}
          <section className="hero-summary">
            <article className="hero-metric accent">
              <span>{lang === "zh" ? "当前列表项" : "Visible items"}</span>
              <strong>{stats.items.toLocaleString()}</strong>
              <small>
                {lang === "zh"
                  ? `文件 ${stats.files.toLocaleString()} / 目录 ${stats.directories.toLocaleString()} / 筛选后 ${stats.filtered.toLocaleString()}`
                  : `Files ${stats.files.toLocaleString()} / Directories ${stats.directories.toLocaleString()} / Filtered ${stats.filtered.toLocaleString()}`}
              </small>
            </article>
            <article className="hero-metric">
              <span>{t(lang, "totalSize")}</span>
              <strong>{formatBytes(stats.totalBytes)}</strong>
              <small>
                {t(lang, "largest")}: {stats.biggest ? formatBytes(stats.biggest.size) : "-"}
              </small>
            </article>
            <article className="hero-metric">
              <span>{t(lang, "kindBreakdown")}</span>
              <strong>
                {stats.kindCounts.video ?? 0} / {stats.kindCounts.image ?? 0} / {stats.kindCounts.document ?? 0}
              </strong>
              <small>{lang === "zh" ? "依据路径与后缀推断" : "Derived by path and extension"}</small>
            </article>
            <article className="hero-metric">
              <span>{t(lang, "trueDuplicates")} / {t(lang, "risks")}</span>
              <strong>
                {bundle.duplicateGroups.length} / {bundle.riskFlags.length}
              </strong>
              <small>{t(lang, "duplicateMembers")}: {bundle.duplicateGroups.reduce((sum, g) => sum + g.memberCount, 0)}</small>
            </article>
          </section>
        </div>
        <div className="hero-actions hero-actions-compact hero-actions-stack">
          <label className="hero-control">
            <span className="control-label-with-icon">
              <Icon path={mdiTranslate} size={0.72} />
              <span>{t(lang, "language")}</span>
            </span>
            <select className="task-select" value={lang} onChange={(event) => setLang(event.target.value as Lang)}>
              <option value="zh">简中</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className="hero-control">
            <span>{t(lang, "dateFormat")}</span>
            <select className="task-select" value={dateFormat} onChange={(event) => setDateFormat(event.target.value as DateFormat)}>
              <option value="ymd">YYYY/MM/DD</option>
              <option value="mdy">MM/DD/YYYY</option>
              <option value="dmy">DD/MM/YYYY</option>
            </select>
          </label>
          <label className="hero-control">
            <span>{t(lang, "timeFormat")}</span>
            <select className="task-select" value={timeFormat} onChange={(event) => setTimeFormat(event.target.value as TimeFormat)}>
              <option value="24h">24h</option>
              <option value="ampm">12h</option>
            </select>
          </label>
        </div>
      </header>

      {state.kind === "error" ? <div className="error-panel">{state.message}</div> : null}

      <section className="layout">
        <aside className="panel sidebar">
          <h2>{t(lang, "filters")}</h2>
          <div className="field-grid">
            <label>
              <span className="label-row"><span>{t(lang, "pathToScan")}</span><InfoTip content={tipText.scanPath} /></span>
              <input
                value={scanRoot}
                onChange={(event) => setScanRoot(event.target.value)}
                placeholder={t(lang, "pathToScan")}
              />
            </label>

            <div className="live-status-card">
              <div className="live-status-meta">
                <div className="label-row compact"><span>{lang === "zh" ? "扫描状态" : "Scan status"}</span><InfoTip content={tipText.scanStatus} /></div>
                <span>{lang === "zh" ? "扫描状态" : "Scan status"}: {liveStatus ?? (lang === "zh" ? "空闲" : "idle")}</span>
                <span>
                  {lang === "zh" ? "阶段" : "Phase"}: {livePhase ?? (lang === "zh" ? "空闲" : "idle")}
                  {livePhaseProgress && livePhaseProgress.total > 0
                    ? ` (${Math.min(100, Math.round((livePhaseProgress.completed / livePhaseProgress.total) * 100))}%)`
                    : ""}
                </span>
                <span>{lang === "zh" ? "已扫描文件" : "Indexed files"}: {(liveStats?.filesIndexed ?? rows.length).toLocaleString()}</span>
                <span>{lang === "zh" ? "已用时" : "Elapsed"}: {elapsedLabel}</span>
              </div>
              {isPossiblyStuck ? (
                <p className="muted">{lang === "zh" ? "文件数长时间未增长，可能卡住或遇到慢目录。" : "File count has not grown for a while, scan may be stalled or on a slow directory."}</p>
              ) : null}
              <div className="panel-actions">
                <button className="ghost-button" type="button" disabled={!scanBusy} onClick={pauseScan}>
                  {lang === "zh" ? "暂停扫描" : "Pause scan"}
                </button>
                <button className="ghost-button danger" type="button" disabled={!scanBusy} onClick={cancelScan}>
                  {lang === "zh" ? "取消扫描" : "Cancel scan"}
                </button>
              </div>
            </div>

            <button className="ghost-button sidebar-primary" type="button" onClick={startScan} disabled={!apiMode || scanBusy}>
              {scanBusy ? t(lang, "scanning") : t(lang, "startScan")}
            </button>

            <label>
              <span className="label-row"><span>{t(lang, "search")}</span><InfoTip content={tipText.search} /></span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                disabled={searchDisabled}
                placeholder={lang === "zh" ? "regex / *.psd / token" : "regex / *.psd / token"}
              />
            </label>

            <label><span className="label-row"><span>{lang === "zh" ? "后缀筛选" : "Suffix filter"}</span><InfoTip content={tipText.suffix} /></span></label>

            <div className={`pill-group ${suffixFilterDisabled ? "is-disabled" : ""}`}>
              <button
                className="pill clear-pill"
                type="button"
                disabled={suffixFilterDisabled || (!includedSuffixes.length && !excludedSuffixes.length)}
                onClick={clearSuffixFilters}
              >
                {lang === "zh" ? "清空筛选" : "Clear filters"}
              </button>
              {visibleSuffixSummaries.length > 0 ? (
                visibleSuffixSummaries.map(({ suffix, count }) => {
                  const includeActive = includedSuffixes.includes(suffix);
                  const excludeActive = excludedSuffixes.includes(suffix);
                  return (
                    <button
                      key={suffix}
                      className={`pill ${includeActive ? "include" : ""} ${excludeActive ? "exclude" : ""}`}
                      type="button"
                      disabled={suffixFilterDisabled}
                      onPointerDown={(event) => handleSuffixPointerDown(event, suffix)}
                      onPointerUp={clearLongPress}
                      onPointerCancel={clearLongPress}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        toggleExcludedSuffix(suffix);
                      }}
                      onClick={() => {
                        if (longPressTriggeredRef.current) {
                          longPressTriggeredRef.current = false;
                          return;
                        }
                        toggleIncludedSuffix(suffix);
                      }}
                      title={`${suffix} (${count})`}
                    >
                      {suffix} <span className="pill-count">{count}</span>
                    </button>
                  );
                })
              ) : (
                <p className="muted">{lang === "zh" ? "扫描完成后会列出后缀（含无后缀和多重后缀）。" : "Suffixes appear after scan (including none and multi-suffix)."}</p>
              )}
              {hiddenSuffixCount > 0 ? (
                <button className="pill clear-pill" type="button" onClick={() => setShowAllSuffixes((current) => !current)}>
                  {showAllSuffixes
                    ? (lang === "zh" ? "收起后缀" : "Collapse suffixes")
                    : (lang === "zh" ? `显示更多后缀 (+${hiddenSuffixCount})` : `Show more suffixes (+${hiddenSuffixCount})`)}
                </button>
              ) : null}
            </div>

            <div className="size-row">
              <label>
                <span className="label-row"><span>{t(lang, "minSize")}</span><InfoTip content={tipText.minSize} /></span>
                <input
                  value={minSizeValue}
                  onChange={(event) => setMinSizeValue(event.target.value.replace(/\D/g, ""))}
                  placeholder={t(lang, "numericOnly")}
                  inputMode="numeric"
                  disabled={duplicateGroupFilterActive}
                />
              </label>
              <label>
                {t(lang, "sizeUnit")}
                <select value={minSizeUnit} onChange={(event) => setMinSizeUnit(event.target.value as Unit)} disabled={duplicateGroupFilterActive}>
                  {Object.keys(unitMap).map((unit) => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="size-row">
              <label>
                <span className="label-row"><span>{t(lang, "maxSize")}</span><InfoTip content={tipText.maxSize} /></span>
                <input
                  value={maxSizeValue}
                  onChange={(event) => setMaxSizeValue(event.target.value.replace(/\D/g, ""))}
                  placeholder={t(lang, "numericOnly")}
                  inputMode="numeric"
                  disabled={duplicateGroupFilterActive}
                />
              </label>
              <label>
                {t(lang, "sizeUnit")}
                <select value={maxSizeUnit} onChange={(event) => setMaxSizeUnit(event.target.value as Unit)} disabled={duplicateGroupFilterActive}>
                  {Object.keys(unitMap).map((unit) => (
                    <option key={unit} value={unit}>
                      {unit}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label><span className="label-row"><span>{t(lang, "riskTypeFilter")}</span><InfoTip content={tipText.risk} /></span></label>
            <div className="pill-group">
              {riskKinds.length > 0 ? (
                riskKinds.map((kind) => {
                  const active = selectedRiskKinds.includes(kind);
                  return (
                    <button
                      key={kind}
                      className={`pill ${active ? "active" : ""}`}
                      type="button"
                      disabled={duplicateGroupFilterActive}
                      onClick={() => toggleRiskKind(kind)}
                    >
                      {kind}
                    </button>
                  );
                })
              ) : (
                <p className="muted">{lang === "zh" ? "暂无风险类型可筛选。" : "No risk types available."}</p>
              )}
            </div>
          </div>

          <div className="mini-list">
            <div className="label-row heading-row"><h3>{t(lang, "trueDuplicates")}</h3><InfoTip content={tipText.duplicates} /></div>
            {duplicateGroupFilterActive ? (
              <button className="pill clear-pill" type="button" onClick={() => setSelectedDuplicateGroupId(null)}>
                {lang === "zh" ? "退出重复组筛选" : "Exit duplicate-group filter"}
              </button>
            ) : null}
            {trueDuplicateGroups.length === 0 ? <p className="muted">{t(lang, "noTrueDuplicates")}</p> : null}
            {trueDuplicateGroups.map((group) => {
              const sortedMembers = [...group.members].sort((a, b) => b.size - a.size);
              const keepSize = sortedMembers[0]?.size ?? 0;
              const reclaim = Math.max(0, group.totalSize - keepSize);
              const active = selectedDuplicateGroupId === group.id;
              const titlePath = sortedMembers[0]?.path ?? "";
              const titleName = titlePath.split(/[\\/]/).pop() || (lang === "zh" ? "未命名文件" : "Unnamed file");
              return (
                <div
                  className={`mini-item mini-item-button ${active ? "is-active" : ""}`}
                  key={group.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleDuplicateGroupFilter(group.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleDuplicateGroupFilter(group.id);
                    }
                  }}
                >
                  <div>
                    <strong>{titleName}</strong>
                    <span>
                      {t(lang, "duplicateMembers")}: {group.memberCount}
                    </span>
                    <span>
                      {t(lang, "duplicateWaste")}: {formatBytes(reclaim)}
                    </span>
                    <span className="duplicate-hash-row">
                      <InfoTip
                        content={group.fullHash}
                        triggerLabel={lang === "zh" ? "哈希值校验完成" : "Hash validation completed"}
                      />
                    </span>
                  </div>
                </div>
              );
            })}

            <h3>{t(lang, "risks")}</h3>
            {filteredRiskFlags.length === 0 ? (
              <p className="muted">{lang === "zh" ? "当前结果里没有风险标记。" : "No risk flags in this dataset."}</p>
            ) : null}
            {filteredRiskFlags.slice(0, 8).map((risk, index) => (
              <div className="mini-item" key={`${risk.filePath}:${risk.kind}:${index}`}>
                <div>
                  <strong>{risk.kind}</strong>
                  <span>{risk.detail}</span>
                  <small>{risk.filePath.split(/[\\/]/).pop()}</small>
                </div>
              </div>
            ))}
          </div>

        </aside>

        <main className="panel table-panel">
          <div className="panel-head">
            <div>
              <h2>{lang === "zh" ? "已索引文件/目录" : "Indexed Files / Directories"}</h2>
              <span>
                {filteredRows.length.toLocaleString()} {t(lang, "rows")}
              </span>
            </div>
            <div className="panel-actions">
              <label className="toggle-chip">
                <input type="checkbox" checked={showFiles} disabled={duplicateGroupFilterActive} onChange={() => setShowFiles((current) => !current)} />
                <span>{lang === "zh" ? "文件" : "Files"}</span>
              </label>
              <label className="toggle-chip">
                <input type="checkbox" checked={showDirectories} disabled={duplicateGroupFilterActive} onChange={() => setShowDirectories((current) => !current)} />
                <span>{lang === "zh" ? "目录" : "Directories"}</span>
              </label>
              <button className="ghost-button" type="button" disabled={!apiMode || selectedRows.length === 0} onClick={copySelectedItems}>
                {lang === "zh" ? "复制选中项" : "Copy selected items"}
              </button>
              <button className="ghost-button danger" type="button" disabled={!apiMode || selectedRows.length === 0} onClick={removeSelectedItems}>
                {lang === "zh" ? "删除选中项" : "Delete selected items"}
              </button>
            </div>
          </div>
          <div
            className="table-wrap"
            ref={tableWrapRef}
            onScroll={(event) => {
              const nextStart = Math.max(0, Math.floor(event.currentTarget.scrollTop / TABLE_ROW_HEIGHT) - TABLE_OVERSCAN);
              setTableStartIndex((current) => (current === nextStart ? current : nextStart));
            }}
          >
            <table>
              <thead>
                <tr>
                  <th className="checkbox-col">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAllVisible}
                      aria-label={lang === "zh" ? "全选" : "Select all"}
                    />
                  </th>
                  <th>
                    <button className="th-button" type="button" onClick={() => cycleSort("name")}>
                      {t(lang, "name")}{sortIndicator("name")}
                    </button>
                  </th>
                  <th>
                    <button className="th-button" type="button" onClick={() => cycleSort("path")}>
                      {t(lang, "path")}{sortIndicator("path")}
                    </button>
                  </th>
                  <th>
                    <button className="th-button" type="button" onClick={() => cycleSort("ext")}>
                      {lang === "zh" ? "后缀/内容" : "Ext / Contents"}{sortIndicator("ext")}
                    </button>
                  </th>
                  <th>
                    <button className="th-button" type="button" onClick={() => cycleSort("size")}>
                      {t(lang, "size")}{sortIndicator("size")}
                    </button>
                  </th>
                  <th>
                    <button className="th-button" type="button" onClick={() => cycleSort("mtimeMs")}>
                      {t(lang, "modified")}{sortIndicator("mtimeMs")}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {topSpacerHeight > 0 ? (
                  <tr aria-hidden="true" className="spacer-row">
                    <td colSpan={TABLE_COLUMN_COUNT} style={{ height: `${topSpacerHeight}px`, padding: 0, border: 0 }} />
                  </tr>
                ) : null}
                {visibleRows.map((row) => {
                  const modifiedParts = formatDateParts(row.mtimeMs, lang, timeFormat, dateFormat);
                  return (
                    <tr
                      key={row.path}
                      className={row.path === selectedPath ? "selected" : ""}
                      onClick={() => setSelectedPath(row.path)}
                    >
                      <td className="checkbox-col" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedSet.has(row.path)}
                          onChange={() => toggleRowSelection(row.path)}
                          aria-label={lang === "zh" ? "选择行" : "Select row"}
                        />
                      </td>
                      <td className={`name-cell ${isDirectorySummary(row) ? "dir-row-cell" : ""}`} title={getDisplayName(row)}>{getDisplayName(row)}</td>
                      <td className="path-cell" title={row.path}>{row.path}</td>
                      <td className="ext-cell">
                        <span className="badge" title={describeMetaCell(row, lang)}>{describeMetaCell(row, lang)}</span>
                      </td>
                      <td className="size-cell">{formatCompactBytes(row.size)}</td>
                      <td className="datetime-cell">
                        <span>{modifiedParts.date}</span>
                        {modifiedParts.time ? <span>{modifiedParts.time}</span> : null}
                      </td>
                    </tr>
                  );
                })}
                {bottomSpacerHeight > 0 ? (
                  <tr aria-hidden="true" className="spacer-row">
                    <td colSpan={TABLE_COLUMN_COUNT} style={{ height: `${bottomSpacerHeight}px`, padding: 0, border: 0 }} />
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </main>

        <div className="detail-column">
          <aside className="panel detail-panel">
            <h2>{t(lang, "details")}</h2>
            {selectedRow ? (
              <div className="detail-grid">
                <div>
                  <span>{t(lang, "pathLabel")}</span>
                  <strong>{selectedRow.path}</strong>
                </div>
                <div>
                  <span>{t(lang, "size")}</span>
                  <strong>{formatBytes(selectedRow.size)}</strong>
                </div>
                <div>
                  <span>{t(lang, "kindLabel")}</span>
                  <strong>{getDisplayKind(selectedRow as DisplayRow, lang)}</strong>
                </div>
                <div>
                  <span>{t(lang, "created")}</span>
                  <strong>{formatDate(selectedRow.ctimeMs, lang, timeFormat, dateFormat)}</strong>
                </div>
                <div>
                  <span>{t(lang, "modified")}</span>
                  <strong>{formatDate(selectedRow.mtimeMs, lang, timeFormat, dateFormat)}</strong>
                </div>
                <div>
                  <span>{t(lang, "status")}</span>
                  <strong>{formatScanStatus(selectedRow.scanStatus, lang)}</strong>
                </div>
              </div>
            ) : (
              <p className="muted">{t(lang, "selectRowHint")}</p>
            )}
          </aside>

          <aside className="panel insight-panel">
            <div className="insight-box">
              <div className="insight-actions">
                <h2>{lang === "zh" ? "这是什么？" : "What is this?"}</h2>
                <button className="ghost-button insight-button" type="button" disabled={insightLoading || !apiMode || !selectedRow} onClick={explainSelectedItems}>
                  {insightLoading
                    ? (lang === "zh" ? "分析中..." : "Analyzing...")
                    : (lang === "zh" ? "分析" : "Analyze")}
                </button>
              </div>
              <small className="muted">
                {selectedRow
                  ? (selectedRows.length > 0
                    ? (lang === "zh" ? `将分析已选 ${selectedRows.length} 项。` : `Will analyze ${selectedRows.length} selected items.`)
                    : (lang === "zh" ? "将分析当前详情项。" : "Will analyze the current detail item."))
                  : t(lang, "selectRowHint")}
              </small>

              {insightError ? <p className="muted">{insightError}</p> : null}

              {insightResult ? (
                <div className="insight-result">
                  <p>{insightResult.summary}</p>
                  <div className="insight-meta">
                    <span>
                      {lang === "zh" ? "删除建议" : "Delete advice"}: {
                        insightResult.deletableAdvice === "safe"
                          ? (lang === "zh" ? "可删除（相对安全）" : "Likely safe")
                          : insightResult.deletableAdvice === "unsafe"
                            ? (lang === "zh" ? "不建议删除" : "Not recommended")
                            : insightResult.deletableAdvice === "caution"
                              ? (lang === "zh" ? "谨慎删除" : "Delete with caution")
                              : (lang === "zh" ? "未知" : "Unknown")
                      }
                    </span>
                    <span>
                      {lang === "zh" ? "置信度" : "Confidence"}: {
                        insightResult.confidence === "high"
                          ? (lang === "zh" ? "高" : "high")
                          : insightResult.confidence === "medium"
                            ? (lang === "zh" ? "中" : "medium")
                            : (lang === "zh" ? "低" : "low")
                      }
                    </span>
                    <span>{lang === "zh" ? "影响" : "Impact"}: {insightResult.impact}</span>
                  </div>
                  {insightResult.reasons.length > 0 ? (
                    <ul>
                      {insightResult.reasons.map((reason, index) => (
                        <li key={`${reason}:${index}`}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      </section>

      <section className="footer-tabs">
        <button className={`footer-tab ${footerTab === "compress" ? "is-active" : ""}`} type="button" onClick={() => setFooterTab("compress")}> 
          {lang === "zh" ? "压缩" : "Compression"}
        </button>
        <button className={`footer-tab ${footerTab === "insight" ? "is-active" : ""}`} type="button" onClick={() => setFooterTab("insight")}> 
          {lang === "zh" ? "智能识别配置" : "Insight config"}
        </button>
        <button className={`footer-tab ${footerTab === "retention" ? "is-active" : ""}`} type="button" onClick={() => setFooterTab("retention")}> 
          {lang === "zh" ? "自动清理策略" : "Retention policy"}
        </button>
      </section>

      {footerTab === "compress" ? (
        <section className="llm-settings-footer">
          <div className="llm-settings-head">
            <h3>{lang === "zh" ? "压缩与打包" : "Compress and package"}</h3>
            <span className="muted">{lang === "zh" ? "默认联动上方选中项" : "Always uses selected items above"}</span>
          </div>
          <small className="muted">
            {lang === "zh"
              ? `将使用上方选中项：${selectedRows.length} 个。`
              : `Using selected items above: ${selectedRows.length} item(s).`}
          </small>
          <div className="llm-settings-grid">
            <label className="hero-control">
              <span>{lang === "zh" ? "模式" : "Mode"}</span>
              <select className="task-select" value={compressionMode} onChange={(event) => setCompressionMode(event.target.value as CompressionMode)}>
                <option value="video">{lang === "zh" ? "视频压缩" : "Video"}</option>
                <option value="image">{lang === "zh" ? "图片压缩" : "Image"}</option>
                <option value="pdf">{lang === "zh" ? "PDF 压缩" : "PDF"}</option>
                <option value="package">{lang === "zh" ? "仅打包（不压缩）" : "Package only (store)"}</option>
              </select>
            </label>
            {compressionMode === "video" ? (
              <label className="hero-control">
                <span>{lang === "zh" ? "批量输出目录（可选）" : "Batch output directory (optional)"}</span>
                <input className="path-input" value={compressOutputDir} onChange={(event) => setCompressOutputDir(event.target.value)} placeholder={lang === "zh" ? "为空则输出到各自原目录" : "Leave empty to output beside each source"} />
              </label>
            ) : null}

            <label className="hero-control">
              <span>{lang === "zh" ? "输出路径（可留空自动生成）" : "Output path (optional)"}</span>
              <input className="path-input" value={compressOutputPath} onChange={(event) => setCompressOutputPath(event.target.value)} placeholder={lang === "zh" ? "可留空" : "Optional"} />
            </label>

            {compressionMode === "video" ? (
              <label className="hero-control">
                <span>{lang === "zh" ? "视频档位" : "Video preset"}</span>
                <select className="task-select" value={videoPreset} onChange={(event) => setVideoPreset(event.target.value as typeof videoPreset)}>
                  <option value="extreme_720p">{lang === "zh" ? "极限压缩 720p" : "Extreme 720p"}</option>
                  <option value="balanced_1080p">{lang === "zh" ? "平衡 1080p" : "Balanced 1080p"}</option>
                  <option value="manual">{lang === "zh" ? "手动" : "Manual"}</option>
                </select>
              </label>
            ) : null}

            {compressionMode === "video" && videoPreset === "manual" ? (
              <>
                <label className="hero-control">
                  <span>{lang === "zh" ? "视频制式" : "Container"}</span>
                  <select className="task-select" value={videoFormat} onChange={(event) => setVideoFormat(event.target.value as VideoFormat)}>
                    <option value="mp4">mp4</option>
                    <option value="mov">mov</option>
                    <option value="mkv">mkv</option>
                  </select>
                </label>
                <label className="hero-control">
                  <span>{lang === "zh" ? "视频码率模式" : "Bitrate mode"}</span>
                  <select className="task-select" value={videoBitrateMode} onChange={(event) => setVideoBitrateMode(event.target.value as VideoBitrateMode)}>
                    <option value="dynamic">{lang === "zh" ? "动态" : "Dynamic"}</option>
                    <option value="static">{lang === "zh" ? "静态" : "Static"}</option>
                  </select>
                </label>
                <label className="hero-control">
                  <span>{lang === "zh" ? "视频码率 (Kbps)" : "Video bitrate (Kbps)"}</span>
                  <input
                    className="path-input"
                    type="number"
                    min={200}
                    max={100000}
                    value={videoBitrateKbps}
                    onChange={(event) => setVideoBitrateKbps(Math.max(200, Math.min(100000, Number(event.target.value || 4500))))}
                  />
                </label>
                <label className="hero-control">
                  <span>{lang === "zh" ? "视频分辨率" : "Resolution"}</span>
                  <select className="task-select" value={videoResolution} onChange={(event) => setVideoResolution(event.target.value as VideoResolution)}>
                    <option value="keep">{lang === "zh" ? "保持" : "Keep"}</option>
                    <option value="1080p">1080p</option>
                    <option value="720p">720p</option>
                    <option value="480p">480p</option>
                    <option value="360p">360p</option>
                    <option value="144p">144p</option>
                  </select>
                </label>
                <label className="hero-control">
                  <span>{lang === "zh" ? "视频帧率" : "Frame rate"}</span>
                  <select className="task-select" value={videoFrameRate} onChange={(event) => setVideoFrameRate(event.target.value as VideoFrameRate)}>
                    <option value="keep">{lang === "zh" ? "保持" : "Keep"}</option>
                    <option value="60">60</option>
                    <option value="59.94">59.94</option>
                    <option value="30">30</option>
                    <option value="29.97">29.97</option>
                    <option value="24">24</option>
                    <option value="23.976">23.976</option>
                    <option value="15">15</option>
                    <option value="10">10</option>
                  </select>
                </label>
              </>
            ) : null}

            {compressionMode === "image" ? (
              <>
                <label className="hero-control">
                  <span>{lang === "zh" ? "图片策略" : "Image strategy"}</span>
                  <select className="task-select" value={imageStrategy} onChange={(event) => setImageStrategy(event.target.value as typeof imageStrategy)}>
                    <option value="keep_resolution">{lang === "zh" ? "保持分辨率压缩" : "Keep resolution"}</option>
                    <option value="resize_and_compress">{lang === "zh" ? "按比例缩放并压缩" : "Resize and compress"}</option>
                  </select>
                </label>
                <label className="hero-control">
                  <span>{lang === "zh" ? "质量 (20-95)" : "Quality (20-95)"}</span>
                  <input className="path-input" type="number" min={20} max={95} value={imageQuality} onChange={(event) => setImageQuality(Math.max(20, Math.min(95, Number(event.target.value || 82))))} />
                </label>
                <label className="hero-control">
                  <span>{lang === "zh" ? "最大宽度" : "Max width"}</span>
                  <input className="path-input" type="number" min={64} value={imageMaxWidth} disabled={imageStrategy !== "resize_and_compress"} onChange={(event) => setImageMaxWidth(Math.max(64, Number(event.target.value || 1920)))} />
                </label>
                <label className="hero-control">
                  <span>{lang === "zh" ? "最大高度" : "Max height"}</span>
                  <input className="path-input" type="number" min={64} value={imageMaxHeight} disabled={imageStrategy !== "resize_and_compress"} onChange={(event) => setImageMaxHeight(Math.max(64, Number(event.target.value || 1080)))} />
                </label>
              </>
            ) : null}

            {compressionMode === "pdf" ? (
              <>
                <label className="hero-control">
                  <span>{lang === "zh" ? "PDF 档位" : "PDF preset"}</span>
                  <select className="task-select" value={pdfPreset} onChange={(event) => setPdfPreset(event.target.value as typeof pdfPreset)}>
                    <option value="screen">screen (smallest)</option>
                    <option value="ebook">ebook</option>
                    <option value="printer">printer (higher quality)</option>
                  </select>
                </label>
                <label className="hero-control">
                  <span>{lang === "zh" ? "目标体积 MB（可选）" : "Target size MB (optional)"}</span>
                  <input className="path-input" type="number" min={0} value={pdfTargetSizeMb} onChange={(event) => setPdfTargetSizeMb(Math.max(0, Number(event.target.value || 0)))} />
                </label>
              </>
            ) : null}

            {compressionMode === "package" ? (
              <>
                <label className="hero-control">
                  <span>{lang === "zh" ? "归档格式" : "Archive format"}</span>
                  <select className="task-select" value={packageFormat} onChange={(event) => setPackageFormat(event.target.value as CompressionArchiveFormat)}>
                    <option value="zip">zip</option>
                    <option value="tar">tar</option>
                  </select>
                </label>
                {packageFormat === "zip" ? (
                  <div className="hero-control">
                    <span>{lang === "zh" ? "打包方式" : "Packaging"}</span>
                    <label className="toggle-chip llm-inline-toggle">
                      <input type="checkbox" checked={packageStoreOnly} onChange={(event) => setPackageStoreOnly(event.target.checked)} />
                      <span>{lang === "zh" ? "仅打包（Store，不压缩）" : "Store only (no compression)"}</span>
                    </label>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
          {compressionError ? <p className="muted">{compressionError}</p> : null}
          {compressionResult ? (
            <p className="muted">
              {lang === "zh" ? "输出" : "Output"}: {compressionResult.outputPath} | {lang === "zh" ? "压缩比" : "Ratio"}: {(compressionResult.ratio * 100).toFixed(1)}%
            </p>
          ) : null}
          {compressionBatchResult ? (
            <p className="muted">
              {lang === "zh" ? "批量结果" : "Batch result"}: {compressionBatchResult.successCount}/{compressionBatchResult.total}
              {compressionBatchResult.outputPath ? ` | ${lang === "zh" ? "归档" : "archive"}: ${compressionBatchResult.outputPath}` : ""}
            </p>
          ) : null}
          <div className="llm-settings-actions">
            <button className="ghost-button" type="button" disabled={compressionRunning || !apiMode} onClick={runCompressionJob}>
              {compressionRunning ? (lang === "zh" ? "处理中..." : "Processing...") : (lang === "zh" ? "开始压缩/打包" : "Run compression/package")}
            </button>
          </div>
        </section>
      ) : null}

      {footerTab === "insight" ? (
        <section className="llm-settings-footer">
          <div className="llm-settings-head">
            <h3>{lang === "zh" ? "智能识别配置" : "Insight config"}</h3>
            <label className="toggle-chip">
              <input
                type="checkbox"
                checked={insightEnabled}
                onChange={(event) => setInsightEnabled(event.target.checked)}
              />
              <span>{lang === "zh" ? "启用智能识别" : "Enable insights"}</span>
            </label>
          </div>
          <div className="llm-settings-grid">
            <label className="hero-control">
              <span>{lang === "zh" ? "模型类型" : "Provider"}</span>
              <select
                className="task-select"
                value={insightSettings.provider === "disabled" ? "ollama" : insightSettings.provider}
                disabled={!insightEnabled}
                onChange={(event) => setInsightSettings((current) => ({ ...current, provider: event.target.value as InsightProvider }))}
              >
                <option value="openai_compatible">OpenAI Compatible</option>
                <option value="ollama">Ollama</option>
              </select>
            </label>
            <label className="hero-control">
              <span>Base URL</span>
              <input
                className="path-input"
                value={insightSettings.baseUrl}
                disabled={!insightEnabled}
                onChange={(event) => setInsightSettings((current) => ({ ...current, baseUrl: event.target.value }))}
                placeholder="http://127.0.0.1:11434"
              />
            </label>
            <label className="hero-control">
              <span>{lang === "zh" ? "模型名" : "Model"}</span>
              <input
                className="path-input"
                value={insightSettings.model}
                disabled={!insightEnabled}
                onChange={(event) => setInsightSettings((current) => ({ ...current, model: event.target.value }))}
                placeholder={lang === "zh" ? "例如 gpt-4.1-mini / qwen3" : "e.g. gpt-4.1-mini / qwen3"}
              />
            </label>
            <label className="hero-control">
              <span>API Key</span>
              <input
                className="path-input"
                type="password"
                value={insightSettings.apiKey}
                disabled={!insightEnabled}
                onChange={(event) => setInsightSettings((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder={lang === "zh" ? "可留空（本地服务）" : "Optional for local providers"}
              />
            </label>
            <div className="hero-control">
              <span>{lang === "zh" ? "Web Search" : "Web search"}</span>
              <label className="toggle-chip llm-inline-toggle">
                <input
                  type="checkbox"
                  checked={insightSettings.webSearchEnabled}
                  disabled={!insightEnabled}
                  onChange={(event) => setInsightSettings((current) => ({ ...current, webSearchEnabled: event.target.checked }))}
                />
                <span>{lang === "zh" ? "启用证据检索" : "Enable evidence lookup"}</span>
              </label>
            </div>
          </div>
          <div className="llm-settings-actions">
            <button className="ghost-button" type="button" disabled={insightSaving || !apiMode} onClick={saveInsightSettings}>
              {insightSaving
                ? (lang === "zh" ? "保存中..." : "Saving...")
                : (lang === "zh" ? "保存智能配置" : "Save insight settings")}
            </button>
          </div>
        </section>
      ) : null}

      {footerTab === "retention" ? (
        <section className="llm-settings-footer">
          <div className="llm-settings-head">
            <h3>{lang === "zh" ? "自动清理策略" : "Retention policy"}</h3>
            <label className="toggle-chip">
              <input
                type="checkbox"
                checked={retentionSettings.enabled}
                onChange={(event) => setRetentionSettings((current) => ({ ...current, enabled: event.target.checked }))}
              />
              <span>{lang === "zh" ? "启用自动清理" : "Enable automatic cleanup"}</span>
            </label>
          </div>
          <div className="llm-settings-grid">
            <label className="hero-control">
              <span>{lang === "zh" ? "扫描快照保留天数" : "Bundle retention days"}</span>
              <input
                className="path-input"
                type="number"
                min={1}
                max={3650}
                value={retentionSettings.keepBundleDays}
                disabled={!retentionSettings.enabled}
                onChange={(event) => setRetentionSettings((current) => ({
                  ...current,
                  keepBundleDays: Math.max(1, Number(event.target.value || 1)),
                }))}
              />
            </label>
            <label className="hero-control">
              <span>{lang === "zh" ? "最多保留快照数" : "Max bundle files"}</span>
              <input
                className="path-input"
                type="number"
                min={1}
                max={5000}
                value={retentionSettings.maxBundleFiles}
                disabled={!retentionSettings.enabled}
                onChange={(event) => setRetentionSettings((current) => ({
                  ...current,
                  maxBundleFiles: Math.max(1, Number(event.target.value || 1)),
                }))}
              />
            </label>
            <label className="hero-control">
              <span>{lang === "zh" ? "任务历史保留天数" : "Task retention days"}</span>
              <input
                className="path-input"
                type="number"
                min={1}
                max={3650}
                value={retentionSettings.keepTaskDays}
                disabled={!retentionSettings.enabled}
                onChange={(event) => setRetentionSettings((current) => ({
                  ...current,
                  keepTaskDays: Math.max(1, Number(event.target.value || 1)),
                }))}
              />
            </label>
            <label className="hero-control">
              <span>{lang === "zh" ? "分析缓存保留天数" : "Analysis cache retention days"}</span>
              <input
                className="path-input"
                type="number"
                min={1}
                max={3650}
                value={retentionSettings.keepAnalysisCacheDays}
                disabled={!retentionSettings.enabled}
                onChange={(event) => setRetentionSettings((current) => ({
                  ...current,
                  keepAnalysisCacheDays: Math.max(1, Number(event.target.value || 1)),
                }))}
              />
            </label>
          </div>
          {retentionError ? <p className="muted">{retentionError}</p> : null}
          <div className="llm-settings-actions">
            <button className="ghost-button" type="button" disabled={retentionSaving || !apiMode} onClick={saveRetentionSettings}>
              {retentionSaving
                ? (lang === "zh" ? "保存中..." : "Saving...")
                : (lang === "zh" ? "保存清理策略" : "Save retention settings")}
            </button>
          </div>
        </section>
      ) : null}

      {toastMessage ? <div className="toast-notice">{toastMessage}</div> : null}
    </div>
  );
}
