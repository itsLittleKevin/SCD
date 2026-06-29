import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runScanTask } from "../src/index.js";

describe("stage7 cli flow", () => {
  it("runs full scan task with exports and state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "diskorg-stage7-"));
    await fs.writeFile(path.join(root, "a.txt"), "a");
    await fs.writeFile(path.join(root, "b.txt"), "b");

    const out = await fs.mkdtemp(path.join(os.tmpdir(), "diskorg-stage7-out-"));
    const statePath = path.join(out, "state.json");
    const csvPath = path.join(out, "files.csv");
    const jsonPath = path.join(out, "files.json");
    const dbPath = path.join(out, "files.sqlite");

    const result = await runScanTask(
      {
        roots: [root],
        skipOneDrivePlaceholders: true,
      },
      {
        saveStatePath: statePath,
        csvPath,
        jsonPath,
        dbPath,
      },
    );

    expect(result.records.length).toBe(2);

    const stateRaw = await fs.readFile(statePath, "utf8");
    const state = JSON.parse(stateRaw) as { indexedPaths: string[] };
    expect(state.indexedPaths.length).toBe(2);

    const csv = await fs.readFile(csvPath, "utf8");
    const json = await fs.readFile(jsonPath, "utf8");
    const db = await fs.stat(dbPath);
    expect(csv).toContain("a.txt");
    expect(json).toContain("b.txt");
    expect(db.size).toBeGreaterThan(100);

    const resumed = await runScanTask(
      { roots: [root], skipOneDrivePlaceholders: true },
      { resumeStatePath: statePath },
    );
    expect(resumed.taskId.length).toBeGreaterThan(0);
  });
});
