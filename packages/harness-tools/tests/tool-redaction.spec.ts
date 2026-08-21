import { describe, expect, it } from "vitest";
import { redactCommand, redactCommandSummary, redactUrl, sha256Hex } from "@innocencecode/harness-tools";

/** Same per-family secret value as the harness-core redaction suite (bash family). */
const SECRETS = {
  bash: "BASH-SECRET-5d3ee7",
} as const;

describe("persistence-safe helpers", () => {
  it("redactCommand keeps only a command-like program word", () => {
    expect(redactCommand("npm test -- -u")).toBe("npm");
    expect(redactCommand("  git   status")).toBe("git");
    expect(redactCommand("node ./scripts/secret-run.js")).toBe("node");
    expect(redactCommand("SK-VERYLONGSECRETVALUE1234567890 run")).toBe("[redacted]");
    expect(redactCommand("")).toBe("[redacted]");
    expect(redactCommand("echo secret-token-value")).not.toContain("secret");
  });

  it("redactCommandSummary keeps program word plus shape-legal subcommands only", () => {
    expect(redactCommandSummary("npm test -- -u")).toBe("npm test");
    expect(redactCommandSummary("npm run build")).toBe("npm run build");
    expect(redactCommandSummary(`deploy --token=${SECRETS.bash}`)).toBe("deploy");
    expect(redactCommandSummary(`send ${SECRETS.bash}`)).toBe("send");
    expect(redactCommandSummary("--flagged npm test")).toBe("[redacted]");
    expect(redactCommandSummary("")).toBe("[redacted]");
  });

  it("redactUrl strips user-info, query and fragment; fails closed on garbage", () => {
    expect(redactUrl("https://user:pass@example.com/path?q=1#frag")).toBe("https://example.com/path");
    expect(redactUrl("file:///workspaces/secret/dir/")).toBe("file:///workspaces/secret/dir/");
    expect(redactUrl("not a url")).toBe("[invalid-url]");
  });

  it("sha256Hex produces stable lowercase hex digests", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abd")).not.toBe(sha256Hex("abc"));
  });
});
