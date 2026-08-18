import { useRef, useState, type KeyboardEvent } from "react";
import { Plus, Folder, ShieldCheck, Square, ArrowUp, ChevronDown } from "lucide-react";
import type { HarnessSettings, PermissionMode } from "../../../shared/ipc";

interface Props {
  t: (key: string) => string;
  streaming: boolean;
  settings: HarnessSettings | null;
  onSettingsChange: (patch: Partial<HarnessSettings>) => void;
  onPickWorkspace: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
}

const MODES: PermissionMode[] = ["auto", "ask", "plan"];
const MOCK_ID = "__mock__";

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
    requestAnimationFrame(() => ref.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const canSend = value.trim().length > 0 && !streaming;
  const workspaceName = settings?.workspaceRoot
    ? (settings.workspaceRoot.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "")
    : "";

  const activeValue = settings
    ? `${settings.activeProfileId}::${settings.activeModel}`
    : `${MOCK_ID}::mock`;
  const activeLabel = (() => {
    if (!settings || settings.activeProfileId === MOCK_ID) return t("provider.mock");
    const profile = settings.profiles.find((p) => p.id === settings.activeProfileId);
    return profile ? `${profile.name} / ${settings.activeModel}` : t("provider.mock");
  })();

  return (
    <div className="shrink-0 px-[clamp(12px,3vw,24px)] pb-[clamp(10px,1.5vw,16px)]">
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-3xl border border-(--color-app-border) bg-(--color-app-panel) shadow-(--shadow-card) transition-colors focus-within:border-(--color-app-accent)">
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
            <button
              type="button"
              onClick={onPickWorkspace}
              title={settings?.workspaceRoot || t("workspace.none")}
              className="flex max-w-[clamp(72px,22%,160px)] items-center gap-1 truncate rounded-full px-2 py-1 hover:bg-(--color-app-bubble) hover:text-(--color-app-text)"
            >
              <Folder size={13} className="shrink-0" />
              <span className="truncate">{workspaceName || t("workspace.none")}</span>
            </button>
            <span className="flex items-center gap-1 rounded-full px-1.5 py-1">
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

            {/* 模型选择：平台分组下拉（可见标签上是全尺寸透明 select） */}
            <div className="relative flex items-center rounded-full hover:bg-(--color-app-bubble)">
              <span className="pointer-events-none flex max-w-[clamp(80px,26%,220px)] items-center gap-1 truncate px-1.5 py-1 text-[11px] font-medium">
                <span className="truncate">{activeLabel}</span>
                <ChevronDown size={11} className="shrink-0" />
              </span>
              <select
                aria-label={t("composer.model")}
                value={activeValue}
                onChange={(e) => {
                  const [profileId, model] = e.target.value.split("::");
                  onSettingsChange({ activeProfileId: profileId, activeModel: model });
                }}
                className="absolute inset-0 w-full cursor-pointer opacity-0"
              >
                <option value={`${MOCK_ID}::mock`}>{t("provider.mock")}</option>
                {(settings?.profiles ?? [])
                  .filter((p) => p.enabled && p.models.length > 0)
                  .map((p) => (
                    <optgroup key={p.id} label={p.name}>
                      {p.models.map((m) => (
                        <option key={m.id} value={`${p.id}::${m.id}`}>
                          {p.name} / {m.id}
                        </option>
                      ))}
                    </optgroup>
                  ))}
              </select>
            </div>

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
