// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRow } from "./ProviderRow";
import type { ProviderProfile } from "../../../../../shared/ipc";

afterEach(cleanup);

const profile: ProviderProfile = { id: "a", name: "智谱", kind: "openai", apiKey: "", baseURL: "", enabled: true, preset: true, models: [] };

describe("ProviderRow", () => {
  it("右键菜单三个动作", () => {
    const onRename = vi.fn();
    render(<ProviderRow profile={profile} active={false} onSelect={() => {}} onRename={onRename} onDuplicate={() => {}} onDelete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    expect(onRename).toHaveBeenCalled();
  });
  it("复制与删除动作回调且菜单关闭", () => {
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    render(<ProviderRow profile={profile} active={false} onSelect={() => {}} onRename={() => {}} onDuplicate={onDuplicate} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: /复制/ }));
    expect(onDuplicate).toHaveBeenCalled();
    // 动作后菜单应关闭：再打开才可见删除项。
    expect(screen.queryByRole("button", { name: /删除/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    expect(onDelete).toHaveBeenCalled();
  });
});
