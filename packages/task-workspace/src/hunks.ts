/**
 * Line-level hunks for text patches.
 *
 * Hunk refs are ALWAYS produced by task-core's fingerprintHunk — the
 * fingerprint algorithm is never duplicated here. Hunks are review/display
 * artifacts; apply/restore works at file level from content objects.
 */
import { diffLines } from "diff";
import { fingerprintHunk, type Hunk } from "@innocencecode/task-core";

/** Unchanged anchor lines recorded before/after each change. */
export const HUNK_CONTEXT_LINES = 3;

function toLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

interface HunkGroup {
  before: string;
  after: string;
  preContext: string[];
  postContext: string[];
}

/**
 * Builds one hunk per maximal run of changed lines. `before` is the joined
 * removed text, `after` the joined added text, `context` the surrounding
 * unchanged anchor lines (up to HUNK_CONTEXT_LINES on each side). New files
 * produce a single hunk with before === "".
 */
export function buildTextHunks(filePath: string, beforeText: string, afterText: string): Hunk[] {
  const parts = diffLines(beforeText, afterText);
  const groups: HunkGroup[] = [];
  let open: HunkGroup | null = null;
  let equalWindow: string[] = [];

  for (const part of parts) {
    if (part.added || part.removed) {
      if (open === null) {
        open = { before: "", after: "", preContext: [...equalWindow], postContext: [] };
      }
      if (part.removed) {
        open.before += part.value;
      }
      if (part.added) {
        open.after += part.value;
      }
      equalWindow = [];
    } else {
      const lines = toLines(part.value);
      if (open !== null && lines.length > 0) {
        open.postContext = lines.slice(0, HUNK_CONTEXT_LINES);
        groups.push(open);
        open = null;
      }
      equalWindow = [...equalWindow, ...lines].slice(-HUNK_CONTEXT_LINES);
    }
  }
  if (open !== null) {
    groups.push(open);
  }

  return groups.map((group) => {
    const context = [...group.preContext, ...group.postContext];
    return {
      ref: fingerprintHunk({ path: filePath, before: group.before, after: group.after, context }),
      path: filePath,
      before: group.before,
      after: group.after,
      context,
      status: "pending",
    } satisfies Hunk;
  });
}
