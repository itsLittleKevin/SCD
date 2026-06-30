import fs from "node:fs/promises";
import path from "node:path";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { DuplicateGroup, FileAnalysisCacheEntry, FileRecord, RiskFlag, RiskKind, ScanConfig, ScanEvent } from "../types.js";
import { newId } from "../utils/ids.js";
import { schemaSql } from "./schema.js";

let sqlModule: SqlJsStatic | null = null;

const loadSqlModule = async (): Promise<SqlJsStatic> => {
  if (sqlModule) {
    return sqlModule;
  }

  sqlModule = await initSqlJs({
    locateFile: (file: string) =>
      path.join(process.cwd(), "node_modules", "sql.js", "dist", file),
  });
  return sqlModule;
};

export class SqliteStore {
  private db: Database;
  private dbFilePath: string | null;

  private constructor(db: Database, dbFilePath: string | null = null) {
    this.db = db;
    this.dbFilePath = dbFilePath;
  }

  static async create(): Promise<SqliteStore> {
    const SQL = await loadSqlModule();
    const db = new SQL.Database();
    db.run(schemaSql);
    return new SqliteStore(db);
  }

  static async openOrCreate(filePath: string): Promise<SqliteStore> {
    const SQL = await loadSqlModule();

    let db: Database;
    try {
      const bytes = await fs.readFile(filePath);
      db = new SQL.Database(new Uint8Array(bytes));
    } catch {
      db = new SQL.Database();
    }

    db.run(schemaSql);
    try {
      db.run(`ALTER TABLE scan_task ADD COLUMN error TEXT`);
    } catch {
      // column already exists
    }
    return new SqliteStore(db, filePath);
  }

  insertTask(taskId: string, cfg: ScanConfig): void {
    const stmt = this.db.prepare(
      `INSERT INTO scan_task (id, started_at, status, error, roots_json, config_json) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    stmt.run([
      taskId,
      new Date().toISOString(),
      "running",
      null,
      JSON.stringify(cfg.roots),
      JSON.stringify(cfg),
    ]);
    stmt.free();
  }

  finishTask(taskId: string, status: string): void {
    this.updateTaskStatus(taskId, status, new Date().toISOString());
  }

  updateTaskStatus(taskId: string, status: string, finishedAt: string | null, error: string | null = null): void {
    const stmt = this.db.prepare(`UPDATE scan_task SET status = ?, finished_at = ?, error = ? WHERE id = ?`);
    stmt.run([status, finishedAt, error, taskId]);
    stmt.free();
  }

  insertFile(record: FileRecord): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO file_record (
        id, task_id, path, parent_path, name, ext, size, ctime_ms, mtime_ms, atime_ms, fs_type, platform, is_dir, scan_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run([
      record.id,
      record.taskId,
      record.path,
      record.parentPath,
      record.name,
      record.ext,
      record.size,
      record.ctimeMs,
      record.mtimeMs,
      record.atimeMs,
      record.fsType,
      record.platform,
      record.isDir ? 1 : 0,
      record.scanStatus,
    ]);
    stmt.free();
  }

  insertRisk(risk: RiskFlag): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO risk_flag (id, task_id, file_path, kind, detail, stage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run([
      risk.id,
      risk.taskId,
      risk.filePath,
      risk.kind,
      risk.detail,
      risk.stage,
      risk.createdAt,
    ]);
    stmt.free();
  }

  insertEvent(taskId: string, ev: ScanEvent): void {
    const stmt = this.db.prepare(
      `INSERT INTO scan_event (id, task_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    stmt.run([newId(), taskId, ev.type, JSON.stringify(ev), new Date().toISOString()]);
    stmt.free();
  }

  insertDuplicateGroup(group: DuplicateGroup): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO duplicate_group (id, task_id, full_hash, total_size, member_count, explanation) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    stmt.run([
      group.id,
      group.taskId,
      group.fullHash,
      group.totalSize,
      group.memberCount,
      group.explanation,
    ]);
    stmt.free();

    const memberStmt = this.db.prepare(
      `INSERT INTO duplicate_member (group_id, file_id, path, size) VALUES (?, ?, ?, ?)`,
    );
    for (const m of group.members) {
      memberStmt.run([group.id, m.fileId, m.path, m.size]);
    }
    memberStmt.free();
  }

  listFiles(taskId: string): FileRecord[] {
    const stmt = this.db.prepare(`SELECT * FROM file_record WHERE task_id = ?`);
    stmt.bind([taskId]);

    const records: FileRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      records.push({
        id: String(row.id),
        taskId: String(row.task_id),
        path: String(row.path),
        parentPath: String(row.parent_path),
        name: String(row.name),
        ext: String(row.ext),
        size: Number(row.size),
        ctimeMs: Number(row.ctime_ms),
        mtimeMs: Number(row.mtime_ms),
        atimeMs: Number(row.atime_ms),
        fsType: String(row.fs_type),
        platform: String(row.platform) as NodeJS.Platform,
        isDir: Number(row.is_dir) === 1,
        scanStatus: String(row.scan_status) as "indexed" | "skipped",
      });
    }
    stmt.free();
    return records;
  }

  async exportDatabase(filePath: string): Promise<void> {
    const bytes = this.db.export();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from(bytes));
  }

  async save(): Promise<void> {
    if (!this.dbFilePath) {
      return;
    }
    await this.exportDatabase(this.dbFilePath);
  }

  listTasks(limit = 50): Array<{
    id: string;
    startedAt: string;
    finishedAt: string | null;
    status: string;
    error: string | null;
    roots: string[];
  }> {
    const stmt = this.db.prepare(
      `SELECT id, started_at, finished_at, status, error, roots_json FROM scan_task ORDER BY started_at DESC LIMIT ?`,
    );
    stmt.bind([limit]);

    const rows: Array<{
      id: string;
      startedAt: string;
      finishedAt: string | null;
      status: string;
      error: string | null;
      roots: string[];
    }> = [];

    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      const rootsRaw = String(row.roots_json ?? "[]");
      rows.push({
        id: String(row.id),
        startedAt: String(row.started_at ?? ""),
        finishedAt: row.finished_at ? String(row.finished_at) : null,
        status: String(row.status ?? "unknown"),
        error: row.error ? String(row.error) : null,
        roots: JSON.parse(rootsRaw) as string[],
      });
    }

    stmt.free();
    return rows;
  }

  getTaskConfig(taskId: string): ScanConfig | null {
    const stmt = this.db.prepare(`SELECT config_json FROM scan_task WHERE id = ? LIMIT 1`);
    stmt.bind([taskId]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as Record<string, unknown>;
    stmt.free();
    return JSON.parse(String(row.config_json)) as ScanConfig;
  }

  listRisks(taskId: string): RiskFlag[] {
    const stmt = this.db.prepare(
      `SELECT id, task_id, file_path, kind, detail, stage, created_at FROM risk_flag WHERE task_id = ? ORDER BY created_at ASC`,
    );
    stmt.bind([taskId]);

    const rows: RiskFlag[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      rows.push({
        id: String(row.id),
        taskId: String(row.task_id),
        filePath: String(row.file_path),
        kind: String(row.kind) as RiskKind,
        detail: String(row.detail),
        stage: String(row.stage),
        createdAt: String(row.created_at),
      });
    }

    stmt.free();
    return rows;
  }

  listFileSkippedReasonCounts(taskId: string): Array<{ reason: string; count: number; samplePath: string | null }> {
    const stmt = this.db.prepare(
      `SELECT payload_json FROM scan_event WHERE task_id = ? AND kind = ? ORDER BY created_at ASC`,
    );
    stmt.bind([taskId, "file_skipped"]);

    const counts = new Map<string, { count: number; samplePath: string | null }>();

    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      const payloadRaw = String(row.payload_json ?? "{}");
      try {
        const parsed = JSON.parse(payloadRaw) as { reason?: unknown; path?: unknown };
        const reason = String(parsed.reason ?? "unknown_skip_reason").trim() || "unknown_skip_reason";
        const samplePath = parsed.path ? String(parsed.path) : null;
        const current = counts.get(reason);
        if (current) {
          current.count += 1;
          if (!current.samplePath && samplePath) {
            current.samplePath = samplePath;
          }
        } else {
          counts.set(reason, { count: 1, samplePath });
        }
      } catch {
        const current = counts.get("unknown_skip_reason");
        if (current) {
          current.count += 1;
        } else {
          counts.set("unknown_skip_reason", { count: 1, samplePath: null });
        }
      }
    }

    stmt.free();

    return [...counts.entries()]
      .map(([reason, info]) => ({ reason, count: info.count, samplePath: info.samplePath }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  }

  listDuplicateGroups(taskId: string): DuplicateGroup[] {
    const groupStmt = this.db.prepare(
      `SELECT id, task_id, full_hash, total_size, member_count, explanation FROM duplicate_group WHERE task_id = ? ORDER BY member_count DESC`,
    );
    groupStmt.bind([taskId]);

    const groups: DuplicateGroup[] = [];

    const memberStmt = this.db.prepare(
      `SELECT file_id, path, size FROM duplicate_member WHERE group_id = ? ORDER BY size DESC, path ASC`,
    );

    while (groupStmt.step()) {
      const row = groupStmt.getAsObject() as Record<string, unknown>;
      const groupId = String(row.id);
      memberStmt.bind([groupId]);

      const members: DuplicateGroup["members"] = [];
      while (memberStmt.step()) {
        const memberRow = memberStmt.getAsObject() as Record<string, unknown>;
        members.push({
          fileId: String(memberRow.file_id),
          path: String(memberRow.path),
          size: Number(memberRow.size),
        });
      }
      memberStmt.reset();

      groups.push({
        id: groupId,
        taskId: String(row.task_id),
        fullHash: String(row.full_hash),
        totalSize: Number(row.total_size),
        memberCount: Number(row.member_count),
        members,
        explanation: String(row.explanation),
      });
    }

    memberStmt.free();
    groupStmt.free();
    return groups;
  }

  listFileAnalysisCache(): FileAnalysisCacheEntry[] {
    const stmt = this.db.prepare(
      `SELECT path, size, mtime_ms, ctime_ms, quick_hash, quick_hash_bytes, full_hash, risk_descriptors_json, updated_at FROM file_analysis_cache`,
    );

    const rows: FileAnalysisCacheEntry[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      rows.push({
        path: String(row.path),
        size: Number(row.size),
        mtimeMs: Number(row.mtime_ms),
        ctimeMs: Number(row.ctime_ms),
        quickHash: row.quick_hash ? String(row.quick_hash) : null,
        quickHashBytes:
          row.quick_hash_bytes === null || row.quick_hash_bytes === undefined
            ? null
            : Number(row.quick_hash_bytes),
        fullHash: row.full_hash ? String(row.full_hash) : null,
        riskDescriptors: JSON.parse(String(row.risk_descriptors_json ?? "[]")),
        updatedAt: String(row.updated_at ?? ""),
      });
    }

    stmt.free();
    return rows;
  }

  upsertFileAnalysisCache(entry: FileAnalysisCacheEntry): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO file_analysis_cache (
        path, size, mtime_ms, ctime_ms, quick_hash, quick_hash_bytes, full_hash, risk_descriptors_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    stmt.run([
      entry.path,
      entry.size,
      entry.mtimeMs,
      entry.ctimeMs,
      entry.quickHash,
      entry.quickHashBytes,
      entry.fullHash,
      JSON.stringify(entry.riskDescriptors),
      entry.updatedAt,
    ]);

    stmt.free();
  }

  listTaskIdsOlderThan(cutoffIso: string): string[] {
    const stmt = this.db.prepare(
      `SELECT id FROM scan_task WHERE started_at IS NOT NULL AND started_at < ? ORDER BY started_at ASC`,
    );
    stmt.bind([cutoffIso]);

    const ids: string[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      ids.push(String(row.id));
    }
    stmt.free();
    return ids;
  }

  deleteTaskData(taskId: string): void {
    const deleteDuplicateMembersStmt = this.db.prepare(
      `DELETE FROM duplicate_member WHERE group_id IN (SELECT id FROM duplicate_group WHERE task_id = ?)`,
    );
    deleteDuplicateMembersStmt.run([taskId]);
    deleteDuplicateMembersStmt.free();

    const statements = [
      `DELETE FROM duplicate_group WHERE task_id = ?`,
      `DELETE FROM risk_flag WHERE task_id = ?`,
      `DELETE FROM file_record WHERE task_id = ?`,
      `DELETE FROM scan_event WHERE task_id = ?`,
      `DELETE FROM scan_task WHERE id = ?`,
    ];

    for (const sql of statements) {
      const stmt = this.db.prepare(sql);
      stmt.run([taskId]);
      stmt.free();
    }
  }

  clearDuplicateGroups(taskId: string): void {
    const deleteDuplicateMembersStmt = this.db.prepare(
      `DELETE FROM duplicate_member WHERE group_id IN (SELECT id FROM duplicate_group WHERE task_id = ?)` ,
    );
    deleteDuplicateMembersStmt.run([taskId]);
    deleteDuplicateMembersStmt.free();

    const stmt = this.db.prepare(`DELETE FROM duplicate_group WHERE task_id = ?`);
    stmt.run([taskId]);
    stmt.free();
  }

  pruneFileAnalysisCacheOlderThan(cutoffIso: string): void {
    const stmt = this.db.prepare(
      `DELETE FROM file_analysis_cache WHERE updated_at IS NOT NULL AND updated_at <> '' AND updated_at < ?`,
    );
    stmt.run([cutoffIso]);
    stmt.free();
  }
}
