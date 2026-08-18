// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderDetail } from "./ProviderDetail";
import type { ProviderProfile } from "../../../../../shared/ipc";

afterEach(cleanup);

const profile: ProviderProfile = {
  id: "a", name: "智谱开放平台", kind: "openai", apiKey: "sk-1", baseURL: "",
  enabled: true, preset: true, models: [],
};
const listModels = vi.fn().mockResolvedValue(["glm-4.6"]);

describe("ProviderDetail", () => {
  it("API Key 显隐切换", () => {
    render(<ProviderDetail profile={profile} listModels={listModels} onChange={() => {}} onToast={() => {}} />);
    expect(screen.getByDisplayValue("••••••••••••")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "显示密钥" }));
    expect(screen.getByDisplayValue("sk-1")).toBeTruthy();
  });
  it("连接检查成功提示", async () => {
    render(<ProviderDetail profile={profile} listModels={listModels} onChange={() => {}} onToast={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    await waitFor(() => expect(listModels).toHaveBeenCalled());
  });
  it("恢复预设地址（智谱无自定义 baseURL 时写入官方地址）", () => {
    const onChange = vi.fn();
    render(<ProviderDetail profile={profile} listModels={listModels} onChange={onChange} onToast={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "恢复预设地址" }));
    expect(onChange).toHaveBeenCalledWith({ baseURL: "https://open.bigmodel.cn/api/paas/v4" });
  });
});
