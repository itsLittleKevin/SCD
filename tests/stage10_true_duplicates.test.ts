import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runScanTask } from "../src/index.js";

describe("stage10 true duplicate output", () => {
  it("exports true duplicate groups into bundle JSON", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "diskorg-stage10-"));
    await fs.writeFile(path.join(root, "a.txt"), "same-payload");
    await fs.writeFile(path.join(root, "b.txt"), "same-payload");
    await fs.writeFile(path.join(root, "c.txt"), "different");

    const out = await fs.mkdtemp(path.join(os.tmpdir(), "diskorg-stage10-out-"));
    const bundlePath = path.join(out, "bundle.json");

    const result = await runScanTask(
      { roots: [root], skipOneDrivePlaceholders: true },
      { bundleJsonPath: bundlePath },
    );

    expect(result.records.length).toBe(3);
    expect(result.duplicateGroups.length).toBe(1);
    expect(result.duplicateGroups[0].memberCount).toBe(2);

    const raw = await fs.readFile(bundlePath, "utf8");
    const bundle = JSON.parse(raw) as {
      summary: { duplicateGroupCount: number; duplicateFileCount: number };
      duplicateGroups: Array<{ memberCount: number }>;
    };

    expect(bundle.summary.duplicateGroupCount).toBe(1);
    expect(bundle.summary.duplicateFileCount).toBe(2);
    expect(bundle.duplicateGroups[0].memberCount).toBe(2);
  });
});
