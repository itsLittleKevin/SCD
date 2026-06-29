import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findDuplicateGroups } from "../src/core/dedupe.js";
import { FileAnalysisCacheEntry } from "../src/types.js";
import { stableId } from "../src/utils/ids.js";

describe("stage4 dedupe", () => {
  it("detects same-content files with different names", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "diskorg-stage4-"));
    const a = path.join(root, "A.mp4");
    const b = path.join(root, "B.mp4");
    const c = path.join(root, "C.mp4");
    await fs.writeFile(a, "same-content");
    await fs.writeFile(b, "same-content");
    await fs.writeFile(c, "different-content");

    const taskId = "task-stage4";
    const records = [a, b, c].map((p) => ({
      id: stableId(p),
      taskId,
      path: p,
      parentPath: root,
      name: path.basename(p),
      ext: path.extname(p),
      size: p === c ? Buffer.byteLength("different-content") : Buffer.byteLength("same-content"),
      ctimeMs: Date.now(),
      mtimeMs: Date.now(),
      atimeMs: Date.now(),
      fsType: "ntfs_like",
      platform: process.platform,
      isDir: false,
      scanStatus: "indexed" as const,
    }));

    const cache = new Map<string, FileAnalysisCacheEntry>();
    const groups = await findDuplicateGroups(taskId, records, {
      quickBytes: 4,
      concurrency: 2,
      analysisCache: cache,
    });
    expect(groups.length).toBe(1);
    expect(groups[0].memberCount).toBe(2);
    expect(groups[0].members.map((m) => path.basename(m.path)).sort()).toEqual([
      "A.mp4",
      "B.mp4",
    ]);
    expect(cache.get(a)?.quickHash).toBeTypeOf("string");
    expect(cache.get(a)?.fullHash).toBeTypeOf("string");
  });
});
