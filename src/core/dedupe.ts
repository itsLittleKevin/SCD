import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { DuplicateGroup, FileAnalysisCacheEntry, FileRecord } from "../types.js";
import { stableId } from "../utils/ids.js";
import { getCurrentCacheEntry, upsertCacheEntry } from "./analysisCache.js";

export interface DedupeProgress {
  stage: "quick_hash" | "full_hash";
  completed: number;
  total: number;
}

export interface FindDuplicateGroupsOptions {
  quickBytes?: number;
  concurrency?: number;
  analysisCache?: Map<string, FileAnalysisCacheEntry>;
  onProgress?: (progress: DedupeProgress) => void;
}

const readRange = async (
  filePath: string,
  start: number,
  length: number,
): Promise<Buffer> => {
  const fh = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
};

const hashBuffer = (buf: Buffer): string =>
  createHash("sha256").update(buf).digest("hex");

const quickHash = async (filePath: string, size: number, quickBytes: number): Promise<string> => {
  const chunk = Math.max(1, quickBytes);
  if (size <= chunk * 2) {
    const content = await fs.readFile(filePath);
    return hashBuffer(content);
  }

  const head = await readRange(filePath, 0, chunk);
  const tail = await readRange(filePath, Math.max(0, size - chunk), chunk);
  return hashBuffer(Buffer.concat([head, tail]));
};

const fullHash = async (filePath: string): Promise<string> => {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", (err) => reject(err));
  });
  return hash.digest("hex");
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) {
          return;
        }
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
};

const toOptions = (
  quickBytesOrOptions?: number | FindDuplicateGroupsOptions,
): Required<Pick<FindDuplicateGroupsOptions, "quickBytes" | "concurrency">>
  & Omit<FindDuplicateGroupsOptions, "quickBytes" | "concurrency"> => {
  if (typeof quickBytesOrOptions === "number" || quickBytesOrOptions === undefined) {
    return {
      quickBytes: quickBytesOrOptions ?? 128 * 1024,
      concurrency: 8,
      analysisCache: undefined,
      onProgress: undefined,
    };
  }

  return {
    quickBytes: quickBytesOrOptions.quickBytes ?? 128 * 1024,
    concurrency: Math.max(1, Math.min(32, Math.trunc(quickBytesOrOptions.concurrency ?? 8))),
    analysisCache: quickBytesOrOptions.analysisCache,
    onProgress: quickBytesOrOptions.onProgress,
  };
};

const resolveQuickHash = async (
  rec: FileRecord,
  quickBytes: number,
  analysisCache?: Map<string, FileAnalysisCacheEntry>,
): Promise<string> => {
  const identity = {
    path: rec.path,
    size: rec.size,
    mtimeMs: rec.mtimeMs,
    ctimeMs: rec.ctimeMs,
  };
  const cachedEntry = getCurrentCacheEntry(analysisCache, identity);
  if (cachedEntry?.quickHash && cachedEntry.quickHashBytes === quickBytes) {
    return cachedEntry.quickHash;
  }

  const digest = await quickHash(rec.path, rec.size, quickBytes);
  upsertCacheEntry(analysisCache, identity, {
    quickHash: digest,
    quickHashBytes: quickBytes,
  });
  return digest;
};

const resolveFullHash = async (
  rec: FileRecord,
  analysisCache?: Map<string, FileAnalysisCacheEntry>,
): Promise<string> => {
  const identity = {
    path: rec.path,
    size: rec.size,
    mtimeMs: rec.mtimeMs,
    ctimeMs: rec.ctimeMs,
  };
  const cachedEntry = getCurrentCacheEntry(analysisCache, identity);
  if (cachedEntry?.fullHash) {
    return cachedEntry.fullHash;
  }

  const digest = await fullHash(rec.path);
  upsertCacheEntry(analysisCache, identity, {
    fullHash: digest,
  });
  return digest;
};

export const findDuplicateGroups = async (
  taskId: string,
  records: FileRecord[],
  quickBytesOrOptions?: number | FindDuplicateGroupsOptions,
): Promise<DuplicateGroup[]> => {
  const opts = toOptions(quickBytesOrOptions);
  const bySize = new Map<number, FileRecord[]>();
  for (const rec of records) {
    const arr = bySize.get(rec.size) ?? [];
    arr.push(rec);
    bySize.set(rec.size, arr);
  }

  const candidates = [...bySize.values()].filter((bucket) => bucket.length > 1);
  const result: DuplicateGroup[] = [];
  const quickTotal = candidates.reduce((sum, bucket) => sum + bucket.length, 0);
  let quickCompleted = 0;
  let fullCompleted = 0;
  let fullTotal = 0;

  if (quickTotal > 0) {
    opts.onProgress?.({ stage: "quick_hash", completed: 0, total: quickTotal });
  }

  for (const bucket of candidates) {
    const byQuick = new Map<string, FileRecord[]>();
    const quickRows = await mapWithConcurrency(bucket, opts.concurrency, async (rec) => {
      const qh = await resolveQuickHash(rec, opts.quickBytes, opts.analysisCache);
      quickCompleted += 1;
      opts.onProgress?.({ stage: "quick_hash", completed: quickCompleted, total: quickTotal });
      return { rec, qh };
    });

    for (const { rec, qh } of quickRows) {
      const arr = byQuick.get(qh) ?? [];
      arr.push(rec);
      byQuick.set(qh, arr);
    }

    const quickCandidates = [...byQuick.values()].filter((g) => g.length > 1);
    for (const qc of quickCandidates) {
      const byFull = new Map<string, FileRecord[]>();
      fullTotal += qc.length;
      opts.onProgress?.({ stage: "full_hash", completed: fullCompleted, total: fullTotal });

      const fullRows = await mapWithConcurrency(qc, opts.concurrency, async (rec) => {
        const fh = await resolveFullHash(rec, opts.analysisCache);
        fullCompleted += 1;
        opts.onProgress?.({ stage: "full_hash", completed: fullCompleted, total: fullTotal });
        return { rec, fh };
      });

      for (const { rec, fh } of fullRows) {
        const arr = byFull.get(fh) ?? [];
        arr.push(rec);
        byFull.set(fh, arr);
      }

      for (const [fh, duplicates] of byFull.entries()) {
        if (duplicates.length < 2) {
          continue;
        }

        const members = duplicates.map((x) => ({
          fileId: x.id,
          path: x.path,
          size: x.size,
        }));
        const totalSize = members.reduce((sum, m) => sum + m.size, 0);
        result.push({
          id: stableId(`${taskId}:${fh}:${members.length}`),
          taskId,
          fullHash: fh,
          totalSize,
          memberCount: members.length,
          members,
          explanation:
            "Matched by size, then quick hash, then full content hash. Names and paths are ignored.",
        });
      }
    }
  }

  return result;
};
