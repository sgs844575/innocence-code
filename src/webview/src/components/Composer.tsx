import { useRef, useState, type KeyboardEvent } from "react";
import { Plus, Folder, MonitorSmartphone, GitBranch, ShieldCheck, Square, ArrowUp } from "lucide-react";

interface Props {
  t: (key: string) => string;
  appName: string;
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ t, appName, streaming, onSend, onStop }: Props): React.JSX.Element {
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

  return (
    <div className="shrink-0 px-6 pb-4">
      <div className="mx-auto w-full max-w-3xl">
        {/* Context pill row: which project/environment/branch this message
            would run against. Purely informational in the mock backend. */}
        <div className="mb-1.5 flex items-center gap-1.5 px-1 text-xs text-(--color-app-muted)">
          <Pill icon={Folder}>{appName}</Pill>
          <Pill icon={MonitorSmartphone}>{t("composer.env")}</Pill>
          <Pill icon={GitBranch}>{t("composer.branch")}</Pill>
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
            <Pill icon={ShieldCheck}>{t("composer.permission")}</Pill>
            <div className="flex-1" />
            <span className="rounded-md bg-(--color-app-bubble) px-2 py-1 text-[11px] font-medium text-(--color-app-muted)">
              {t("composer.model")}
            </span>
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

function Pill({ icon: Icon, children }: { icon: typeof Folder; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-(--color-app-bubble)">
      <Icon size={13} />
      {children}
    </span>
  );
}

function autosize(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 176)}px`;
}
