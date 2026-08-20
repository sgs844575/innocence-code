import { describe, expect, it } from "vitest";
import { fingerprintHunk, migrateReviewStatuses, type Hunk } from "../src/index";

const hunk = (overrides: Partial<Hunk> = {}): Hunk => ({
  ref: "h1",
  path: "src/a.ts",
  before: "const a = 1;\n",
  after: "const a = 2;\n",
  context: ["const b = 3;"],
  status: "pending",
  ...overrides,
});

describe("fingerprintHunk", () => {
  it("is stable across calls and fresh objects with the same input", () => {
    const first = fingerprintHunk({ path: "src/a.ts", before: "x\n", after: "y\n", context: ["ctx"] });
    const second = fingerprintHunk({ context: ["ctx"], after: "y\n", before: "x\n", path: "src/a.ts" });
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes line endings and trailing whitespace before hashing", () => {
    const base = fingerprintHunk({ path: "src/a.ts", before: "x\n", after: "y\n", context: ["ctx"] });
    const crlf = fingerprintHunk({ path: "src/a.ts", before: "x\r\n", after: "y\r\n", context: ["ctx\r\n"] });
    expect(crlf).toBe(base);
    const paddedContext = fingerprintHunk({ path: "src/a.ts", before: "x\n", after: "y\n", context: ["ctx  "] });
    expect(paddedContext).toBe(base);
  });

  it("separates differing path, content or context anchors", () => {
    const base = fingerprintHunk({ path: "src/a.ts", before: "x\n", after: "y\n", context: ["ctx"] });
    expect(fingerprintHunk({ path: "src/b.ts", before: "x\n", after: "y\n", context: ["ctx"] })).not.toBe(base);
    expect(fingerprintHunk({ path: "src/a.ts", before: "x\n", after: "z\n", context: ["ctx"] })).not.toBe(base);
    expect(fingerprintHunk({ path: "src/a.ts", before: "w\n", after: "y\n", context: ["ctx"] })).not.toBe(base);
    expect(fingerprintHunk({ path: "src/a.ts", before: "x\n", after: "y\n", context: ["other"] })).not.toBe(base);
  });
});

describe("migrateReviewStatuses", () => {
  it("inherits accepted only on exact fingerprint match", () => {
    const next = migrateReviewStatuses([hunk({ status: "accepted" })], [hunk({ ref: "h2" })]);
    expect(next[0]?.status).toBe("accepted");
  });

  it("resets a re-appearing restored hunk to pending", () => {
    const next = migrateReviewStatuses([hunk({ status: "restored" })], [hunk({ ref: "h2" })]);
    expect(next[0]?.status).toBe("pending");
  });

  it("keeps conflict on exact match (only an explicit resolution event may leave it)", () => {
    const next = migrateReviewStatuses([hunk({ status: "conflict" })], [hunk({ ref: "h2" })]);
    expect(next[0]?.status).toBe("conflict");
  });

  it("downgrades to pending on fingerprint mismatch (content change / context overlap)", () => {
    const next = migrateReviewStatuses(
      [hunk({ status: "accepted" })],
      [hunk({ ref: "h2", after: "const a = 3;\n" }), hunk({ ref: "h3", context: ["different anchor"] })],
    );
    expect(next[0]?.status).toBe("pending");
    expect(next[1]?.status).toBe("pending");
  });

  it("marks brand-new hunks pending", () => {
    const next = migrateReviewStatuses([hunk({ status: "accepted" })], [hunk({ ref: "h2", path: "src/new.ts" })]);
    expect(next[0]?.status).toBe("pending");
  });

  it("preserves an incoming conflict without an exact-match predecessor", () => {
    const next = migrateReviewStatuses(
      [hunk({ status: "accepted" })],
      [hunk({ ref: "h2", path: "src/moved.ts", status: "conflict" })],
    );
    expect(next[0]?.status).toBe("conflict");
  });

  it("returns new hunk objects without mutating either side", () => {
    const previous = [hunk({ status: "accepted" })];
    const next = [hunk({ ref: "h2" })];
    const migrated = migrateReviewStatuses(previous, next);
    expect(migrated[0]).not.toBe(next[0]);
    expect(next[0]?.status).toBe("pending");
    expect(previous[0]?.status).toBe("accepted");
  });
});
