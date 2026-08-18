// Minimal glob -> RegExp converter shared by permission path rules and the
// fs tools. Supports: ** (any chars incl. /), * (any chars except /),
// ? (one char except /), {a,b} alternation, and escaping with \.

export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) throw new Error(`dangling escape in glob: ${pattern}`);
      re += escapeLiteral(next);
      i += 2;
      continue;
    }
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // "**" — also swallow a following "/" so "src/**" matches "src/a/b.ts"
        // and "a/**/b" matches "a/x/y/b".
        re += "(?:.*)";
        i += 2;
        if (pattern[i] === "/") i += 1;
      } else {
        re += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) throw new Error(`unbalanced { in glob: ${pattern}`);
      const alts = pattern
        .slice(i + 1, end)
        .split(",")
        .map((a) => a.split("").map(escapeLiteral).join(""));
      re += `(?:${alts.join("|")})`;
      i = end + 1;
      continue;
    }
    re += escapeLiteral(ch);
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function escapeLiteral(ch: string): string {
  return /[a-zA-Z0-9_\- ]/.test(ch) ? ch : `\\${ch}`;
}

export function matchGlob(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}
