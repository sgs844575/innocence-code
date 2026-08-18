import { useRef, useState, type KeyboardEvent } from "react";
import { Plus, Folder, ShieldCheck, Square, ArrowUp } from "lucide-react";
import type { HarnessSettings, PermissionMode, ProviderKind } from "../../../shared/ipc";

interface Props {
  t: (key: string) => string;
  streaming: boolean;
  settings: HarnessSettings | null;
  onSettingsChange: (patch: Partial<HarnessSettings>) => void;
  onPickWorkspace: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
}

const PROVIDERS: ProviderKind[] = ["mock", "openai", "anthropic"];
const MODES: PermissionMode[] = ["auto", "ask", "plan"];

export function Composer({
  t,
  streaming,
  settings,
  onSettingsChange,
  onPickWorkspace,
  onSend,
  onStop,
}: Props): React.JSX.Element {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = (): void => {
    const text = value.trim();
    if (!text || streaming) return;
    onSend(text);
    setValue("");
    // Keep focus for follow-up messages.
    requestAnimationFrame(() => ref.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const canSend = value.trim().length > 0 && !streaming;
  const provider = settings?.providerId ?? "mock";
  const providerSettings =
    provider === "openai"
      ? settings?.openai
      : provider === "anthropic"
        ? settings?.anthropic
        : undefined;
  const needsKey = provider !== "mock" && !providerSettings?.apiKey;
  const workspaceName = settings?.workspaceRoot
    ? settings.workspaceRoot.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? ""
    : "";

  return (
    <div className="shrink-0 px-6 pb-4">
      <div className="mx-auto w-full max-w-3xl">
        {/* Inline provider credentials — appears only when a real provider is
            selected but has no key yet. */}
        {needsKey && (
          <div className="mb-1.5 flex items-center gap-2 rounded-lg border border-(--color-app-border) bg-(--color-app-panel) px-3 py-2 text-xs">
            <input
              type="password"
              placeholder={t("settings.apiKey")}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-(--color-app-muted)"
              onChange={(e) => {
                if (!settings) return;
                if (provider === "openai") {
                  onSettingsChange({ openai: { ...settings.openai, apiKey: e.target.value } });
                } else if (provider === "anthropic") {
                  onSettingsChange({
                    anthropic: { ...settings.anthropic, apiKey: e.target.value },
                  });
                }
              }}
            />
            <input
              type="text"
              placeholder={provider === "openai" ? t("settings.model") : t("settings.model")}
              defaultValue={provider === "openai" ? settings?.openai.model : settings?.anthropic.model}
              className="w-40 shrink-0 bg-transparent outline-none placeholder:text-(--color-app-muted)"
              onChange={(e) => {
                if (!settings) return;
                if (provider === "openai") {
                  onSettingsChange({ openai: { ...settings.openai, model: e.target.value } });
                } else if (provider === "anthropic") {
                  onSettingsChange({
                    anthropic: { ...settings.anthropic, model: e.target.value },
                  });
                }
              }}
            />
          </div>
        )}

        <div className="mb-1.5 flex items-center gap-1.5 px-1 text-xs text-(--color-app-muted)">
          <button
            type="button"
            onClick={onPickWorkspace}
            title={settings?.workspaceRoot || t("workspace.none")}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-(--color-app-bubble)"
          >
            <Folder size={13} />
            {workspaceName || t("workspace.none")}
          </button>
          <span className="flex items-center gap-1 rounded-md px-1.5 py-1">
            <ShieldCheck size={13} />
            <select
              aria-label={t("permission.mode")}
              value={settings?.permissionMode ?? "ask"}
              onChange={(e) =>
                onSettingsChange({ permissionMode: e.target.value as PermissionMode })
              }
              className="cursor-pointer appearance-none bg-transparent outline-none"
            >
              {MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`permission.mode.${mode}`)}
                </option>
              ))}
            </select>
          </span>
          <div className="flex-1" />
          <select
            aria-label={t("composer.model")}
            value={provider}
            onChange={(e) => onSettingsChange({ providerId: e.target.value as ProviderKind })}
            className="cursor-pointer appearance-none rounded-md bg-(--color-app-bubble) px-2 py-1 text-[11px] font-medium text-(--color-app-muted) outline-none"
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {t(`provider.${p}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="rounded-2xl border border-(--color-app-border) bg-(--color-app-panel) shadow-sm focus-within:border-(--color-app-accent)">
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
          <div className="flex items-center gap-2 px-2.5 pb-2">
            <button
              type="button"
              aria-label="添加附件"
              className="grid size-7 shrink-0 place-items-center rounded-lg text-(--color-app-muted) hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
            >
              <Plus size={16} />
            </button>
            <div className="flex-1" />
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
                className="grid size-8 shrink-0 place-items-center rounded-full bg-(--color-app-accent) text-(--color-app-accent-fg) transition-all active:scale-95 disabled:opacity-30"
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
