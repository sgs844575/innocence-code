// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "./MarkdownView";

const codeBlockCss = readFileSync(path.resolve("src/webview/src/styles/app.css"), "utf8");
const productTokenCss = readFileSync(path.resolve("src/webview/src/styles/tokens/product.css"), "utf8");

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("MarkdownView", () => {
  it("渲染标题/列表/内联代码", () => {
    render(<MarkdownView source={"# T\n\n- a `b`\n\n**x**"} />);
    expect(screen.getByRole("heading", { name: "T" })).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();
  });
  it("围栏代码块走 CodeBlock（语言标签 + 复制按钮）", async () => {
    const { container } = render(<MarkdownView source={"```ts\n// note\nconst a = 1\n```"} />);
    expect(await screen.findByText("ts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
    const block = container.querySelector(".code-block");
    expect(block).toBeTruthy();
    expect(block!.className).toContain("bg-(--color-code-bg)");
    const classes = Array.from(block!.querySelectorAll("[class]"), (node) => node.className).join(" ");
    expect(classes).not.toContain("white/");
    expect(classes).toContain("text-(--color-app-muted)");
    expect(classes).toContain("bg-(--color-code-control-bg)");
    // 钉住真实 Shiki 高亮路径：catch 回退（纯 pre）不会渲染 .code-html
    await waitFor(() => expect(container.querySelector(".code-html")).toBeTruthy());
    const shikiHtml = container.querySelector<HTMLElement>(".code-html")?.innerHTML ?? "";
    expect(shikiHtml).toContain("--shiki-light");
    expect(shikiHtml).toContain("--shiki-dark");
    expect(shikiHtml).toContain("--shiki-light-font-style");
    expect(shikiHtml).toContain("--shiki-dark-font-style");
  });

  it("亮暗主题完整映射 Shiki token 样式", () => {
    const lightRule = ruleBody(codeBlockCss, ".code-block .code-html span");
    const darkRule = ruleBody(codeBlockCss, ".electron-dark .code-block .code-html span");
    expect(lightRule).toContain("--shiki-light-bg: transparent");
    expect(lightRule).toContain("--shiki-dark-bg: transparent");
    const mappings = [
      ["color", ""],
      ["background-color", "-bg"],
      ["font-style", "-font-style"],
      ["font-weight", "-font-weight"],
      ["text-decoration", "-text-decoration"],
    ] as const;
    for (const [property, suffix] of mappings) {
      expect(lightRule).toContain(`${property}: var(--shiki-light${suffix});`);
      expect(darkRule).toContain(`${property}: var(--shiki-dark${suffix});`);
    }
  });

  it("亮暗主题均定义代码块表面和控件 token", () => {
    const lightTokens = ruleBody(productTokenCss, ":root");
    const darkTokens = ruleBody(productTokenCss, ":root.electron-dark");
    for (const token of [
      "--color-code-bg",
      "--color-code-fg",
      "--color-code-control-bg",
      "--color-code-control-bg-hover",
      "--color-code-control-fg",
      "--color-code-control-fg-hover",
    ]) {
      expect(lightTokens).toContain(`${token}:`);
      expect(darkTokens).toContain(`${token}:`);
    }
  });
});
