// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThinkingBlock } from "./ThinkingBlock";

afterEach(cleanup);

describe("ThinkingBlock", () => {
  it("折叠态显示思考秒数", () => {
    render(<ThinkingBlock text="abc def ghi jkl mno pqr" live={false} />);
    expect(screen.getByText(/已思考/)).toBeTruthy();
  });
  it("流式态显示 shimmer 预览", () => {
    render(<ThinkingBlock text="正在想" live />);
    expect(screen.getByText(/正在想/)).toBeTruthy();
  });
});
