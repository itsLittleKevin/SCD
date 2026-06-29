import { describe, expect, it } from "vitest";
import {
  shouldSkipDirectory,
  shouldSkipFileByRules,
  shouldSkipOneDrivePlaceholder,
} from "../src/core/filter.js";

describe("stage3 filter", () => {
  it("filters by glob and include rule", () => {
    const cfg = {
      roots: ["D:/data"],
      excludeGlobs: ["**/*.tmp"],
      includeGlobs: ["**/*.psd"],
    };

    expect(shouldSkipFileByRules("D:/data/a.tmp", 100, cfg)).toBe("exclude_glob");
    expect(shouldSkipFileByRules("D:/data/a.jpg", 100, cfg)).toBe(
      "not_in_include_glob",
    );
    expect(shouldSkipFileByRules("D:/data/a.psd", 100, cfg)).toBeNull();
  });

  it("skips default cache folders only on nested paths", () => {
    const cfg = { roots: ["D:/cache"] };
    expect(shouldSkipDirectory("D:/cache", cfg, 0)).toBeNull();
    expect(shouldSkipDirectory("D:/cache/node_modules", cfg, 1)).toBe(
      "default_cache_rule",
    );
  });

  it("detects likely OneDrive placeholders", () => {
    const cfg = { roots: ["D:/OneDrive"], skipOneDrivePlaceholders: true };
    expect(
      shouldSkipOneDrivePlaceholder("D:/OneDrive/empty.txt", 0, cfg),
    ).toBe("onedrive_placeholder");
    expect(
      shouldSkipOneDrivePlaceholder("D:/OneDrive/full.txt", 123, cfg),
    ).toBeNull();
  });
});
