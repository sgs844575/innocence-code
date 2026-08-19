import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Plus, Square, ArrowUp } from "lucide-react";
import {
  MOCK_MODEL,
  MOCK_PROFILE_ID,
  type HarnessSettings,
  type ProviderProfile,
} from "../../../shared/ipc";
import { ModelPicker } from "./composer/ModelPicker";
import { PermissionModePicker } from "./composer/PermissionModePicker";
import { AgentPicker } from "./composer/AgentPicker";
import { ThinkingEffortPicker } from "./composer/ThinkingEffortPicker";
import { useCommandK } from "./composer/useCommandK";

interface Props {
  t: (key: string) => string;
  streaming: boolean;
  settings: HarnessSettings | null;
  onSettingsChange: (patch: Partial<HarnessSettings>) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /** 引用通道注入文本：并入输入框后立即回调 onConsumed 清掉 draft。 */
  initialText?: string;
  onConsumed?: () => void;
  /** 面板首行（落地态的项目选择器；聊天态不传 = 无此行）。 */
  header?: ReactNode;
}

export function Composer({
  t,
  streaming,
  settings,
  onSettingsChange,
  onSend,
  onStop,
  initialText,
  onConsumed,
  header,
}: Props): React.JSX.Element {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!initialText) return;
    setValue((v) => (v ? `${v}\n${initialText}` : initialText));
    onConsumed?.();
    requestAnimationFrame(() => ref.current?.focus());
    // 依赖只含 initialText：onConsumed 后 draft 已清空，回调引用不触发重复并入。
  }, [initialText]);

  // ⌘K/Ctrl+K 唤起二级模型面板：点击 ModelPicker 的触发按钮（data 属性锚定，
  // 免去 ref 穿透 Popover 组件树）。
  useCommandK(
    useCallback(() => {
      document.querySelector<HTMLButtonElement>("[data-model-picker-trigger]")?.click();
    }, []),
  );

  const submit = (): void => {
    const text = value.trim();
    if (!text || streaming) return;
    onSend(text);
    setValue("");
    requestAnimationFrame(() => ref.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const canSend = value.trim().length > 0 && !streaming;

  // Mock 是虚拟厂家（不在 settings.profiles 中）——组装层注入伪 profile，
  // 保持旧 select 的能力：chip 显示「本地 Mock」，且可从面板切回 mock。
  const pickerSettings: HarnessSettings | null = settings
    ? {
        ...settings,
        profiles: settings.profiles.some((p) => p.id === MOCK_PROFILE_ID)
          ? settings.profiles
          : [mockProfile(t), ...settings.profiles],
      }
    : null;

  return (
    <div className="shrink-0 px-[clamp(12px,3vw,24px)] pb-[clamp(10px,1.5vw,16px)]">
      <div className="chat-column">
        <div className="rounded-[18px] border border-(--color-app-border) bg-(--color-app-panel) shadow-(--shadow-card) transition-colors focus-within:border-(--color-app-accent)">
          {header && <div className="px-2.5 pt-2.5">{header}</div>}
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              autosize(e.target);
            }}
            onKeyDown={onKeyDown}
            placeholder={t("chat.placeholder")}
            rows={1}
            className="scrollbar-thin max-h-44 min-h-9 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm leading-relaxed outline-none placeholder:text-(--color-app-muted) disabled:opacity-50"
          />
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2 text-xs text-(--color-app-muted)">
            <button
              type="button"
              aria-label="添加附件"
              className="grid size-7 shrink-0 place-items-center rounded-full hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
            >
              <Plus size={15} />
            </button>
            <PermissionModePicker
              t={t}
              value={settings?.permissionMode ?? "ask"}
              onChange={(mode) => onSettingsChange({ permissionMode: mode })}
            />
            <div className="flex-1" />

            {pickerSettings ? (
              <ModelPicker
                settings={pickerSettings}
                activeProfileId={pickerSettings.activeProfileId}
                activeModel={pickerSettings.activeModel}
                onSelect={(profileId, modelId) =>
                  onSettingsChange({ activeProfileId: profileId, activeModel: modelId })
                }
              />
            ) : (
              <button
                type="button"
                disabled
                className="flex max-w-[200px] items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium"
              >
                <span className="truncate">{t("provider.mock")}</span>
              </button>
            )}

            <AgentPicker
              t={t}
              value={settings?.activeAgent ?? "default"}
              onChange={(agent) => onSettingsChange({ activeAgent: agent })}
            />

            <ThinkingEffortPicker
              t={t}
              value={settings?.reasoningEffort ?? ""}
              onChange={(effort) => onSettingsChange({ reasoningEffort: effort })}
            />

            {streaming ? (
              <button
                type="button"
                onClick={onStop}
                aria-label={t("chat.stop")}
                className="grid size-8 shrink-0 place-items-center rounded-full bg-(--color-app-bubble) transition-transform active:scale-95"
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                aria-label={t("chat.send")}
                className="grid size-8 shrink-0 place-items-center rounded-full bg-[linear-gradient(135deg,var(--color-app-accent),color-mix(in_srgb,var(--color-app-accent)_72%,#2563eb))] text-(--color-app-accent-fg) shadow-md transition-all active:scale-95 disabled:opacity-30 disabled:shadow-none"
              >
                <ArrowUp size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function autosize(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 176)}px`;
}

function mockProfile(t: (key: string) => string): ProviderProfile {
  return {
    id: MOCK_PROFILE_ID,
    name: t("provider.mock"),
    kind: "openai",
    apiKey: "",
    baseURL: "",
    enabled: true,
    models: [{ id: MOCK_MODEL, name: t("provider.mock"), source: "preset" }],
  };
}
