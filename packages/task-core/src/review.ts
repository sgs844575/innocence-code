import { createHash } from "node:crypto";
import type { Hunk } from "./model";

export interface HunkFingerprintInput {
  path: string;
  before: string;
  after: string;
  context: string[];
}

/** Normalizes line endings and trailing newlines of hunk content. */
function normalizeContent(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/** Normalizes a context anchor line: line endings plus trailing whitespace. */
function normalizeContextLine(line: string): string {
  return line.replace(/\r\n?/g, "\n").replace(/\s+$/g, "");
}

function normalizeContext(context: string[]): string[] {
  const lines = context.map(normalizeContextLine);
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Stable SHA-256 hex fingerprint over the canonical serialization of
 * { path, before, after, context[] }. Same input in any process yields
 * the same hash; only path/patch/context participate — never `ref` or
 * review status.
 */
export function fingerprintHunk(input: HunkFingerprintInput): string {
  const canonical = JSON.stringify({
    after: normalizeContent(input.after),
    before: normalizeContent(input.before),
    context: normalizeContext(input.context),
    path: input.path,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Carries review statuses from a previous hunk list onto the next one.
 * A next hunk inherits its predecessor's status ONLY on an exact
 * fingerprint match (same path, normalized patch and context anchors):
 *
 * - no predecessor (new hunk / changed content / context overlap) -> pending,
 *   except an incoming `conflict` is preserved (migration never downgrades
 *   a conflict to pending)
 * - predecessor `restored` and the hunk re-appears              -> pending
 * - predecessor `conflict` on exact match                        -> conflict
 *   (migration never leaves `conflict`; only an explicit
 *   conflict-resolution event processed by the reducer may)
 * - otherwise the previous status is inherited.
 *
 * Pure: returns new hunk objects and mutates neither side.
 */
export function migrateReviewStatuses(previous: Hunk[], next: Hunk[]): Hunk[] {
  const previousByFingerprint = new Map<string, Hunk>();
  for (const hunk of previous) {
    previousByFingerprint.set(fingerprintHunk(hunk), hunk);
  }
  return next.map((hunk) => {
    const predecessor = previousByFingerprint.get(fingerprintHunk(hunk));
    if (predecessor === undefined) {
      return { ...hunk, status: hunk.status === "conflict" ? "conflict" : "pending" };
    }
    if (predecessor.status === "restored") {
      return { ...hunk, status: "pending" };
    }
    if (predecessor.status === "conflict") {
      return { ...hunk, status: "conflict" };
    }
    return { ...hunk, status: predecessor.status };
  });
}
