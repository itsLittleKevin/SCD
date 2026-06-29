import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportBundleJson, exportToCsv, exportToJson } from "../src/core/exporters.js";
import { SqliteStore } from "../src/storage/sqliteStore.js";

describe("stage6 storage and export", () => {
  it("stores and exports records", async () => {
    const store = await SqliteStore.create();
    const taskId = "task-stage6";
    store.insertTask(taskId, { roots: ["D:/data"] });
    store.insertFile({
      id: "f1",
      taskId,
      path: "D:/data/a.txt",
      parentPath: "D:/data",
      name: "a.txt",
      ext: ".txt",
      size: 12,
      ctimeMs: 1,
      mtimeMs: 2,
      atimeMs: 3,
      fsType: "ntfs_like",
      platform: process.platform,
      isDir: false,
      scanStatus: "indexed",
    });
    store.finishTask(taskId, "finished");

    const all = store.listFiles(taskId);
    expect(all.length).toBe(1);

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "diskorg-stage6-"));
    const csvPath = path.join(root, "out.csv");
    const jsonPath = path.join(root, "out.json");
    const bundlePath = path.join(root, "bundle.json");
    const dbPath = path.join(root, "out.sqlite");

    await exportToCsv(all, csvPath);
    await exportToJson(all, jsonPath);
    await exportBundleJson(
      {
        taskId,
        createdAt: new Date().toISOString(),
        config: { roots: ["D:/data"] },
        summary: {
          totalFiles: all.length,
          totalBytes: all.reduce((sum, row) => sum + row.size, 0),
          duplicateGroupCount: 0,
          duplicateFileCount: 0,
          duplicateWasteBytes: 0,
          riskCount: 0,
        },
        records: all,
        duplicateGroups: [],
        riskFlags: [],
      },
      bundlePath,
    );
    await store.exportDatabase(dbPath);

    const csv = await fs.readFile(csvPath, "utf8");
    const json = await fs.readFile(jsonPath, "utf8");
    const bundle = await fs.readFile(bundlePath, "utf8");
    const dbStat = await fs.stat(dbPath);

    expect(csv).toContain("a.txt");
    expect(json).toContain("\"a.txt\"");
    expect(bundle).toContain("\"summary\"");
    expect(dbStat.size).toBeGreaterThan(100);
  });

  it("round-trips file analysis cache entries", async () => {
    const store = await SqliteStore.create();
    store.upsertFileAnalysisCache({
      path: "D:/data/a.txt",
      size: 12,
      mtimeMs: 2,
      ctimeMs: 1,
      quickHash: "quick",
      quickHashBytes: 4096,
      fullHash: "full",
      riskDescriptors: [{ kind: "possibly_corrupt", detail: "example", stage: "risk" }],
      updatedAt: new Date().toISOString(),
    });

    const rows = store.listFileAnalysisCache();
    expect(rows.length).toBe(1);
    expect(rows[0].quickHash).toBe("quick");
    expect(rows[0].fullHash).toBe("full");
    expect(rows[0].riskDescriptors[0]?.kind).toBe("possibly_corrupt");
  });
});
