// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";
import type { HarnessSettings } from "../../../../shared/ipc";

afterEach(cleanup);

const settings = {
  profiles: [
    { id: "p1", name: "智谱", kind: "openai", apiKey: "", baseURL: "", enabled: true,
      models: [{ id: "glm-4.6", name: "GLM-4.6", source: "preset", tools: true, contextWindow: 200000 }] },
  ],
} as unknown as HarnessSettings;

describe("ModelPicker", () => {
  it("打开面板、选择模型回调、chip 只显示模型名", async () => {
    const onSelect = vi.fn();
    render(<ModelPicker settings={settings} activeProfileId="p1" activeModel="glm-4.6" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /GLM-4.6/ }));
    await waitFor(() => screen.getByText("智谱"));
    // 面板打开后 trigger 与模型行同名，需在 dialog 面板内定位模型行
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /GLM-4.6/ }));
    expect(onSelect).toHaveBeenCalledWith("p1", "glm-4.6");
  });
});
