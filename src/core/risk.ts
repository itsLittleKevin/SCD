import fs from "node:fs/promises";
import { RiskFlag, RiskKind } from "../types.js";
import { newId } from "../utils/ids.js";

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;

const toRisk = (
  taskId: string,
  filePath: string,
  kind: RiskKind,
  detail: string,
  stage = "risk",
): RiskFlag => ({
  id: newId(),
  taskId,
  filePath,
  kind,
  detail,
  stage,
  createdAt: new Date().toISOString(),
});

export const detectLongPathRisk = (
  taskId: string,
  filePath: string,
): RiskFlag | null => {
  if (process.platform !== "win32") {
    return null;
  }
  if (filePath.length < 248) {
    return null;
  }
  return toRisk(taskId, filePath, "long_path", "path_exceeds_windows_safe_limit");
};

export const detectEncryptedZipRisk = async (
  taskId: string,
  filePath: string,
): Promise<RiskFlag | null> => {
  if (!filePath.toLowerCase().endsWith(".zip")) {
    return null;
  }

  const fh = await fs.open(filePath, "r");
  try {
    const header = Buffer.alloc(30);
    const { bytesRead } = await fh.read(header, 0, 30, 0);
    if (bytesRead < 30) {
      return toRisk(taskId, filePath, "possibly_corrupt", "zip_header_too_short");
    }

    const sig = header.readUInt32LE(0);
    if (sig !== ZIP_LOCAL_FILE_HEADER) {
      return toRisk(taskId, filePath, "possibly_corrupt", "zip_signature_mismatch");
    }

    const gpFlag = header.readUInt16LE(6);
    if ((gpFlag & 0x0001) === 0x0001) {
      return toRisk(taskId, filePath, "encrypted_archive", "zip_encryption_flag_set");
    }

    return null;
  } finally {
    await fh.close();
  }
};

export const detectEncryptedPdfRisk = async (
  taskId: string,
  filePath: string,
): Promise<RiskFlag | null> => {
  if (!filePath.toLowerCase().endsWith(".pdf")) {
    return null;
  }

  const fh = await fs.open(filePath, "r");
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    const content = head.subarray(0, bytesRead).toString("latin1");

    if (!content.startsWith("%PDF-")) {
      return toRisk(taskId, filePath, "possibly_corrupt", "pdf_header_missing");
    }

    if (content.includes("/Encrypt")) {
      return toRisk(taskId, filePath, "encrypted_pdf", "pdf_encrypt_marker_found");
    }

    return null;
  } finally {
    await fh.close();
  }
};

export const analyzeRisks = async (
  taskId: string,
  filePath: string,
): Promise<RiskFlag[]> => {
  const risks: RiskFlag[] = [];

  const longPath = detectLongPathRisk(taskId, filePath);
  if (longPath) {
    risks.push(longPath);
  }

  const zipRisk = await detectEncryptedZipRisk(taskId, filePath);
  if (zipRisk) {
    risks.push(zipRisk);
  }

  const pdfRisk = await detectEncryptedPdfRisk(taskId, filePath);
  if (pdfRisk) {
    risks.push(pdfRisk);
  }

  return risks;
};
