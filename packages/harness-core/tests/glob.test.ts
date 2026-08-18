import { describe, expect, it } from "vitest";
import { globToRegExp, matchGlob } from "../src/glob";

describe("globToRegExp", () => {
  it.each([
    ["src/**", "src/a/b.ts", true],
    ["src/**", "src/a/b.ts", true],
    ["src/**", "srcx/a.ts", false],
    ["**/*.ts", "deep/nested/x.ts", true],
    ["**/*.ts", "deep/nested/x.js", false],
    ["*.ts", "a.ts", true],
    ["*.ts", "src/a.ts", false],
    ["a?c.ts", "abc.ts", true],
    ["a?c.ts", "ac.ts", false],
    ["a?c.ts", "a/c.ts", false],
    ["{a,b}.ts", "a.ts", true],
    ["{a,b}.ts", "b.ts", true],
    ["{a,b}.ts", "c.ts", false],
    ["a.b.ts", "axb.ts", false], // dots are literal
    ["a+b.ts", "a+b.ts", true], // plus is literal
  ])("%s vs %s -> %s", (pattern, value, expected) => {
    expect(matchGlob(pattern, value)).toBe(expected);
  });

  it("accepts backslash-separated values via matchGlob callers", () => {
    // Callers normalize separators; the regex itself only sees forward slashes.
    expect(globToRegExp("src/**").test("src/a.ts")).toBe(true);
  });

  it("throws on unbalanced braces and dangling escapes", () => {
    expect(() => globToRegExp("{a,b")).toThrow();
    expect(() => globToRegExp("a\\")).toThrow();
  });
});
