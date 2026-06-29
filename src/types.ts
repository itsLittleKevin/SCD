export type RiskKind =
  | "encrypted_archive"
  | "encrypted_pdf"
  | "unreadable"
  | "long_path"
  | "onedrive_offline"
  | "permission_denied"
  | "io_error"
  | "possibly_corrupt";

export interface ScanConfig {
  roots: string[];
  minSizeBytes?: number;
  maxSizeBytes?: number;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  excludePaths?: string[];
  skipOneDrivePlaceholders?: boolean;
  followSymlinks?: boolean;
  quickHashBytes?: number;
  maxDepth?: number;
  ioConcurrency?: number;
  dedupeConcurrency?: number;
  enableUnchangedFileCache?: boolean;
}

export interface FileRecord {
  id: string;
  taskId: string;
  path: string;
  parentPath: string;
  name: string;
  ext: string;
  size: number;
  ctimeMs: number;
  mtimeMs: number;
  atimeMs: number;
  fsType: string;
  platform: NodeJS.Platform;
  isDir: boolean;
  scanStatus: "indexed" | "skipped";
}

export interface RiskFlag {
  id: string;
  taskId: string;
  filePath: string;
  kind: RiskKind;
  detail: string;
  stage: string;
  createdAt: string;
}

export interface CachedRiskDescriptor {
  kind: RiskKind;
  detail: string;
  stage: string;
}

export interface FileAnalysisCacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  quickHash: string | null;
  quickHashBytes: number | null;
  fullHash: string | null;
  riskDescriptors: CachedRiskDescriptor[];
  updatedAt: string;
}

export interface DuplicateMember {
  fileId: string;
  path: string;
  size: number;
}

export interface DuplicateGroup {
  id: string;
  taskId: string;
  fullHash: string;
  totalSize: number;
  memberCount: number;
  members: DuplicateMember[];
  explanation: string;
}

export interface ScanResultSummary {
  totalFiles: number;
  totalBytes: number;
  duplicateGroupCount: number;
  duplicateFileCount: number;
  duplicateWasteBytes: number;
  riskCount: number;
}

export interface ScanResultBundle {
  taskId: string;
  createdAt: string;
  config: ScanConfig;
  summary: ScanResultSummary;
  records: FileRecord[];
  duplicateGroups: DuplicateGroup[];
  riskFlags: RiskFlag[];
}

export interface ScanStats {
  dirsVisited: number;
  filesVisited: number;
  filesIndexed: number;
  filesSkipped: number;
  risks: number;
}

export type ScanEvent =
  | { type: "scan_started"; taskId: string; roots: string[] }
  | { type: "directory_entered"; path: string }
  | { type: "file_seen"; path: string; size: number }
  | { type: "file_indexed"; record: FileRecord }
  | { type: "file_skipped"; path: string; reason: string }
  | { type: "risk_flag"; risk: RiskFlag }
  | { type: "scan_finished"; taskId: string; stats: ScanStats };
