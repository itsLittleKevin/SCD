import { createHash, randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

export const stableId = (text: string): string =>
  createHash("sha1").update(text).digest("hex");
