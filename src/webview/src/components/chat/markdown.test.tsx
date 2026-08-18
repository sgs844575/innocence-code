// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "./MarkdownView";

describe("MarkdownView", () => {
  it("渲染标题/列表/内联代码", () => {
    render(<MarkdownView source={"# T\n\n- a `b`\n\n**x**"} />);
    expect(screen.getByRole("heading", { name: "T" })).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();
  });
  it("围栏代码块走 CodeBlock（语言标签 + 复制按钮）", async () => {
    render(<MarkdownView source={"```ts\nconst a = 1\n```"} />);
    expect(await screen.findByText("ts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制" })).toBeTruthy();
  });
});
