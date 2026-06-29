import path from "node:path";

export const normalizePath = (input: string): string => {
  const normalized = path.normalize(input);
  if (process.platform !== "win32") {
    return normalized;
  }

  if (normalized.startsWith("\\\\?\\")) {
    return normalized;
  }

  if (normalized.length >= 248 && /^[a-zA-Z]:\\/.test(normalized)) {
    return "\\\\?\\" + normalized;
  }

  return normalized;
};

export const isLikelyOneDrivePath = (p: string): boolean => {
  const lower = p.toLowerCase();
  return (
    lower.includes("\\onedrive\\") ||
    lower.includes("/onedrive/") ||
    lower.includes("onedrive -")
  );
};
