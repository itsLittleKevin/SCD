import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeRisks,
  detectEncryptedPdfRisk,
  detectEncryptedZipRisk,
} from "../src/core/risk.js";

describe("stage5 risk", () => {
  it("detects encrypted zip flag", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "diskorg-stage5-zip-"));
    const zipPath = path.join(root, "enc.zip");

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0001, 6);
    await fs.writeFile(zipPath, header);

    const risk = await detectEncryptedZipRisk("task", zipPath);
    expect(risk?.kind).toBe("encrypted_archive");
  });

  it("detects encrypted pdf marker", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "diskorg-stage5-pdf-"));
    const pdfPath = path.join(root, "enc.pdf");
    await fs.writeFile(pdfPath, "%PDF-1.6\n1 0 obj\n<< /Encrypt true >>\nendobj\n");

    const risk = await detectEncryptedPdfRisk("task", pdfPath);
    expect(risk?.kind).toBe("encrypted_pdf");
  });

  it("returns no risk for normal text file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "diskorg-stage5-none-"));
    const filePath = path.join(root, "a.txt");
    await fs.writeFile(filePath, "ok");

    const risks = await analyzeRisks("task", filePath);
    expect(risks.length).toBe(0);
  });
});
