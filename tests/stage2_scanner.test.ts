import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskId, scanFiles } from "../src/core/scanner.js";

describe("stage2 scanner", () => {
  it("streams indexed events", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "diskorg-stage2-"));
    const sub = path.join(root, "sub");
    await fs.mkdir(sub);
    await fs.writeFile(path.join(root, "a.txt"), "hello");
    await fs.writeFile(path.join(sub, "b.txt"), "world");

    const events: string[] = [];
    const indexed: string[] = [];

    for await (const ev of scanFiles(createTaskId(), { roots: [root] })) {
      events.push(ev.type);
      if (ev.type === "file_indexed") {
        indexed.push(ev.record.path);
      }
    }

    expect(events[0]).toBe("scan_started");
    expect(events.at(-1)).toBe("scan_finished");
    expect(indexed.length).toBe(2);
  });

  it("applies min and max size filter", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "diskorg-stage2-size-"));
    await fs.writeFile(path.join(root, "small.bin"), Buffer.alloc(10));
    await fs.writeFile(path.join(root, "ok.bin"), Buffer.alloc(200));
    await fs.writeFile(path.join(root, "big.bin"), Buffer.alloc(5000));

    let indexed = 0;
    const skippedReasons: string[] = [];

    for await (const ev of scanFiles(createTaskId(), {
      roots: [root],
      minSizeBytes: 100,
      maxSizeBytes: 1000,
    })) {
      if (ev.type === "file_indexed") {
        indexed += 1;
      }
      if (ev.type === "file_skipped") {
        skippedReasons.push(ev.reason);
      }
    }

    expect(indexed).toBe(1);
    expect(skippedReasons).toContain("below_min_size");
    expect(skippedReasons).toContain("above_max_size");
  });
});
