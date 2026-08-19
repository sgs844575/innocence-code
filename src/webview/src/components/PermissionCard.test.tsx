// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatPermissionEvent } from "../../../shared/ipc";
import { PermissionCard } from "./PermissionCard";

afterEach(cleanup);

const t = (key: string) => key;

const request: ChatPermissionEvent = {
  sessionId: "s1",
  messageId: "m1",
  requestId: "p1",
  toolName: "Write",
  args: { path: "src/a.ts" },
  resource: { kind: "file", action: "write", scope: "src/a.ts" },
};

describe("PermissionCard 资源摘要渲染", () => {
  it("显示 kind/action/scope 稳定摘要与工具名", () => {
    render(<PermissionCard t={t} request={request} onRespond={() => {}} />);
    expect(screen.getByText("Write")).toBeTruthy();
    expect(screen.getByText("write")).toBeTruthy();
    expect(screen.getByText("file")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
  });

  it("args 默认折叠，点开 summary 后可见", () => {
    const { container } = render(<PermissionCard t={t} request={request} onRespond={() => {}} />);
    const details = container.querySelector("details");
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    fireEvent.click(details!.querySelector("summary")!);
    expect(details?.open).toBe(true);
    expect(screen.getByText(/"path": "src\/a\.ts"/)).toBeTruthy();
  });

  it("拒绝 / 会话内允许 / 允许一次 分别回调对应选择", () => {
    const onRespond = vi.fn();
    render(<PermissionCard t={t} request={request} onRespond={onRespond} />);
    fireEvent.click(screen.getByText("permission.card.deny"));
    fireEvent.click(screen.getByText("permission.card.allowSession"));
    fireEvent.click(screen.getByText("permission.card.allow"));
    expect(onRespond.mock.calls).toEqual([
      ["p1", "deny"],
      ["p1", "allowSession"],
      ["p1", "allow"],
    ]);
  });
});
