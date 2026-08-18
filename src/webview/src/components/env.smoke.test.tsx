// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("组件测试环境", () => {
  it("react 渲染进 jsdom", () => {
    render(<button>hi</button>);
    expect(screen.getByRole("button", { name: "hi" })).toBeTruthy();
  });
});
