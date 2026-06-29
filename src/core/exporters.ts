import fs from "node:fs/promises";
import { FileRecord, ScanResultBundle } from "../types.js";

const csvEscape = (value: string): string =>
  /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export const exportToCsv = async (
  records: FileRecord[],
  filePath: string,
): Promise<void> => {
  const headers = [
    "path",
    "name",
    "ext",
    "size",
    "ctimeMs",
    "mtimeMs",
    "atimeMs",
    "fsType",
    "platform",
    "scanStatus",
  ];

  const lines = [headers.join(",")];
  for (const rec of records) {
    const line = [
      rec.path,
      rec.name,
      rec.ext,
      String(rec.size),
      String(rec.ctimeMs),
      String(rec.mtimeMs),
      String(rec.atimeMs),
      rec.fsType,
      rec.platform,
      rec.scanStatus,
    ].map(csvEscape);
    lines.push(line.join(","));
  }

  await fs.writeFile(filePath, lines.join("\n"), "utf8");
};

export const exportToJson = async (
  records: FileRecord[],
  filePath: string,
): Promise<void> => {
  await fs.writeFile(filePath, JSON.stringify(records, null, 2), "utf8");
};

export const exportBundleJson = async (
  bundle: ScanResultBundle,
  filePath: string,
): Promise<void> => {
  await fs.writeFile(filePath, JSON.stringify(bundle, null, 2), "utf8");
};
