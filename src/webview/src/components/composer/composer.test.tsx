// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../Composer";
import type { HarnessSettings } from "../../../../shared/ipc";

const settings = {
  profiles: [
    { id: "p1", name: "智谱", kind: "openai", apiKey: "", baseURL: "", enabled: true,
      models: [{ id: "glm-4.6", source: "preset", tools: true }] },
  ],
  activeProfileId: "p1", activeModel: "glm-4.6", workspaceRoot: "D:/x/InnocenceCode", permissionMode: "ask",
} as unknown as HarnessSettings;
const t = (k: string) => k;

afterEach(cleanup);

describe("Composer", () => {
  it("输入回车发送并清空", () => {
    const onSend = vi.fn();
    render(<Composer t={t} streaming={false} settings={settings} onSettingsChange={() => {}} onPickWorkspace={() => {}} onSend={onSend} onStop={() => {}} />);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "hi" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hi");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });
  it("权限模式切换走 Popover 而非原生 select", () => {
    const onSettingsChange = vi.fn();
    render(<Composer t={t} streaming={false} settings={settings} onSettingsChange={onSettingsChange} onPickWorkspace={() => {}} onSend={() => {}} onStop={() => {}} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /permission.mode/ }));
    fireEvent.click(screen.getByRole("button", { name: /permission.mode.auto/ }));
    expect(onSettingsChange).toHaveBeenCalledWith({ permissionMode: "auto" });
  });
});
