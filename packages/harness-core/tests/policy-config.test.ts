import { describe, expect, it } from "vitest";
import { rulesFromConfig } from "../src/policy-config";

function vote(spec: string, kind: "allow" | "deny", call: { toolName: string; args: Record<string, unknown> }) {
  const rule = rulesFromConfig({ [kind]: [spec] })[0];
  return rule.match(call);
}

describe("project permission rule specs", () => {
  it("bare tool name matches every call of that tool", () => {
    expect(vote("Read", "allow", { toolName: "Read", args: {} })).toBe("allow");
    expect(vote("Read", "allow", { toolName: "Edit", args: {} })).toBe("skip");
  });

  it("Bash(npm test) matches prefix command sequences, not all npm", () => {
    const c = (command: string) => ({ toolName: "Bash", args: { command } });
    expect(vote("Bash(npm test)", "allow", c("npm test"))).toBe("allow");
    expect(vote("Bash(npm test)", "allow", c("npm test -- -u"))).toBe("allow");
    expect(vote("Bash(npm test)", "allow", c("npm install"))).toBe("skip");
    expect(vote("Bash(npm test)", "allow", c("npmcitest foo"))).toBe("skip");
  });

  it("Bash(*) wildcard token matches any single token", () => {
    const c = (command: string) => ({ toolName: "Bash", args: { command } });
    expect(vote("Bash(npm run *)", "allow", c("npm run build"))).toBe("allow");
    expect(vote("Bash(npm run *)", "allow", c("npm run"))).toBe("skip");
  });

  it("Edit(src/**) matches workspace-relative globs", () => {
    const c = (path: string) => ({ toolName: "Edit", args: { path } });
    expect(vote("Edit(src/**)", "allow", c("src/a/b.ts"))).toBe("allow");
    expect(vote("Edit(src/**)", "allow", c("docs/a.md"))).toBe("skip");
    expect(vote("Edit(src/**)", "deny", c("package.json"))).toBe("skip");
  });

  it("invalid specs throw", () => {
    expect(() => rulesFromConfig({ allow: [""] })).toThrow();
    expect(() => rulesFromConfig({ allow: ["Bash(npm"] })).toThrow();
  });

  it("deny rules are listed before allow rules", () => {
    const rules = rulesFromConfig({ allow: ["Read"], deny: ["Bash(rm *)"] });
    expect(rules[0].name).toBe("deny:Bash(rm *)");
    expect(rules).toHaveLength(2);
  });
});
