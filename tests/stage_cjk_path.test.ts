import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskId, scanFiles } from "../src/core/scanner.js";

describe("cjk path support", () => {
  it("scans directories and files with CJK names", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "diskorg-cjk-"));
    const cjkDir = path.join(base, "测试目录", "子目录");
    await fs.mkdir(cjkDir, { recursive: true });

    const cjkFileA = path.join(base, "测试目录", "文件A.txt");
    const cjkFileB = path.join(cjkDir, "另一个文件B.log");
    await fs.writeFile(cjkFileA, "hello-cjk-a");
    await fs.writeFile(cjkFileB, "hello-cjk-b");

    const indexed: string[] = [];
    for await (const ev of scanFiles(createTaskId(), { roots: [base] })) {
      if (ev.type === "file_indexed") {
        indexed.push(ev.record.path);
      }
    }

    expect(indexed.some((p) => p.includes("测试目录") && p.includes("文件A.txt"))).toBe(true);
    expect(indexed.some((p) => p.includes("子目录") && p.includes("另一个文件B.log"))).toBe(true);
  });
});
