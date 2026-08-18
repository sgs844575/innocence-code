// 添加厂家对话框：名称 + 密钥 + 双端点（OpenAI/Anthropic）+ 基于预设快速创建。
import { useMemo, useState } from "react";
import type { ProviderPresetMirror, ProviderProfile } from "../../../../../shared/ipc";

type PresetOption = ProviderPresetMirror;

interface Props {
  open: boolean;
  /** 由 SettingsView 从 shared 契约的 PROVIDER_PRESET_MIRROR 传入。 */
  presets: PresetOption[];
  onClose: () => void;
  onCreate: (profile: ProviderProfile) => void;
}

/** 添加厂家：名称 + 密钥 + 双端点（OpenAI/Anthropic）+ 基于预设。 */
export function AddProviderDialog({ open, presets, onClose, onCreate }: Props): React.JSX.Element {
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [kind, setKind] = useState<"openai" | "anthropic">("openai");
  const [baseURL, setBaseURL] = useState("");
  const [query, setQuery] = useState("");
  const hit = useMemo(
    () => presets.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase())),
    [presets, query],
  );
  if (!open) return <></>;

  const submit = (base: PresetOption | null) => {
    const finalName = name.trim() || base?.name || "自定义平台";
    const finalKind = base ? base.kind : kind;
    const finalBase = baseURL.trim() || base?.baseURL || "";
    const models = (base?.models ?? []).map((id) => ({ id, source: "preset" as const }));
    onCreate({
      id: `custom_${Date.now().toString(36)}`,
      name: finalName,
      kind: finalKind,
      apiKey,
      baseURL: finalBase,
      enabled: true,
      models,
      preset: false,
    });
    setName("");
    setApiKey("");
    setBaseURL("");
    setQuery("");
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center">
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="fade-in absolute inset-0 bg-black/25"
      />
      <div className="relative w-[440px] rounded-2xl border border-(--color-app-border) bg-(--color-app-panel) p-5 shadow-(--shadow-pop)">
        <h2 className="mb-4 text-[14px] font-semibold">添加厂家</h2>
        <div className="flex flex-col gap-3 text-[12.5px]">
          <label className="flex flex-col gap-1">
            名称
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 我的转发站"
              className="h-8 rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) px-2 outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            API 密钥（可选）
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-8 rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) px-2 font-mono text-[12px] outline-none"
            />
          </label>
          <div className="flex flex-col gap-1">
            端点类型
            <div className="flex gap-1.5">
              {(["openai", "anthropic"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`rounded-full border px-3 py-1 text-[11.5px] ${
                    kind === k
                      ? "border-(--color-app-accent) bg-(--color-app-accent-soft) text-(--color-app-accent)"
                      : "border-(--color-app-border) text-(--color-app-muted)"
                  }`}
                >
                  {k === "openai" ? "OpenAI 兼容" : "Anthropic"}
                </button>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-1">
            Base URL
            <input
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder={kind === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
              className="h-8 rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) px-2 font-mono text-[12px] outline-none"
            />
          </label>
          <div className="flex flex-col gap-1.5 border-t border-(--color-app-hairline) pt-3">
            基于预设创建
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索预设…"
              className="h-8 rounded-lg border border-(--color-app-hairline) bg-(--color-app-bg) px-2 text-[12px] outline-none"
            />
            <div className="scrollbar-thin max-h-36 overflow-y-auto">
              {hit.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => submit(p)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] hover:bg-(--color-app-bubble)/50"
                >
                  {p.name}
                  <span className="ml-auto font-mono text-[10px] text-(--color-app-muted)">
                    {p.models.length} 模型
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-(--color-app-border) px-3 py-1.5 text-[12px]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => submit(null)}
              className="rounded-lg bg-(--color-app-accent) px-3 py-1.5 text-[12px] font-medium text-(--color-app-accent-fg)"
            >
              创建
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
