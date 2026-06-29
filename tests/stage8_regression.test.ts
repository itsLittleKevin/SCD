import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTaskId, scanFiles } from "../src/core/scanner.js";

describe("stage8 regression", () => {
  it("flags and skips encrypted zip during scan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "diskorg-stage8-"));
    const zipPath = path.join(root, "secret.zip");

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0001, 6);
    await fs.writeFile(zipPath, header);

    let sawEncryptedRisk = false;
    let skippedEncrypted = false;

    for await (const ev of scanFiles(createTaskId(), { roots: [root] })) {
      if (ev.type === "risk_flag" && ev.risk.kind === "encrypted_archive") {
        sawEncryptedRisk = true;
      }
      if (ev.type === "file_skipped" && ev.reason === "encrypted_content") {
        skippedEncrypted = true;
      }
    }

    expect(sawEncryptedRisk).toBe(true);
    expect(skippedEncrypted).toBe(true);
  });

  it("quick hash handles large files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "diskorg-stage8-large-"));
    const a = path.join(root, "a.bin");
    const b = path.join(root, "b.bin");

    const payload = Buffer.alloc(1024 * 1024, 7);
    await fs.writeFile(a, payload);
    await fs.writeFile(b, payload);

    const indexed: string[] = [];
    for await (const ev of scanFiles(createTaskId(), { roots: [root], quickHashBytes: 64 * 1024 })) {
      if (ev.type === "file_indexed") {
        indexed.push(ev.record.path);
      }
    }

    expect(indexed.length).toBe(2);
  });
});
