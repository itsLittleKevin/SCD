import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("stage1 docs", () => {
  it("has architecture doc", () => {
    expect(existsSync("docs/architecture.md")).toBe(true);
  });

  it("has schema doc", () => {
    expect(existsSync("docs/schema.md")).toBe(true);
  });

  it("has flow doc", () => {
    expect(existsSync("docs/flow.md")).toBe(true);
  });
});
