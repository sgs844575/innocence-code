import { useEffect, useRef, useState } from "react";
import { Rocket, Wrench, GitPullRequestArrow, Bug } from "lucide-react";
import type { ChatMessage, ChatPermissionEvent, HarnessSettings, PermissionChoice } from "../../../shared/ipc";
import { MessageItem } from "./MessageItem";
import { Composer } from "./Composer";
import { PermissionCard } from "./PermissionCard";

interface Props {
  t: (key: string) => string;
  appName: string;
  messages: ChatMessage[];
  streaming: boolean;
  settings: HarnessSettings | null;
  permission: ChatPermissionEvent | null;
  onSettingsChange: (patch: Partial<HarnessSettings>) => void;
  onPickWorkspace: () => void;
  onPermissionRespond: (requestId: string, choice: PermissionChoice) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function ChatView({
  t,
  appName,
  messages,
  streaming,
  settings,
  permission,
  onSettingsChange,
  onPickWorkspace,
  onPermissionRespond,
  onSend,
  onStop,
}: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // 贴底策略：用户上滚（scrollTop 减小）→ 暂停跟随；回到底部（距底 <48px）→ 恢复。
  // 判定必须带方向：smooth 跟随动画期间流式内容长高，中途帧距底会 >48px，
  // 纯距离判定会把程序滚动误判成用户上滚使 pinned 自锁为 false；而向下滚动
  // （含程序动画）不会让 scrollTop 减小，方向判定天然免疫，对惯性/回弹也稳健。
  const [pinned, setPinned] = useState(true);
  const lastScrollTop = useRef(0);
  // 引用通道：操作栏「引用」把文本塞进 Composer，Composer 消费后回调清空。
  const [quoteDraft, setQuoteDraft] = useState("");

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    const wentUp = el.scrollTop < lastScrollTop.current;
    lastScrollTop.current = el.scrollTop;
    if (wentUp && !atBottom) setPinned(false);
    else if (atBottom) setPinned(true);
  };

  useEffect(() => {
    if (pinned) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pinned]);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="scrollbar-thin flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-[clamp(12px,3vw,24px)] pb-6">
          {messages.length === 0 ? (
            <EmptyState t={t} appName={appName} onPick={onSend} />
          ) : (
            <div className="space-y-5 pt-6">
              {messages.map((m) => (
                <MessageItem
                  key={m.id}
                  t={t}
                  message={m}
                  isLatest={m.id === messages[messages.length - 1]?.id}
                  onQuote={setQuoteDraft}
                />
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {permission && (
        <div className="px-[clamp(12px,3vw,24px)]">
          <PermissionCard t={t} request={permission} onRespond={onPermissionRespond} />
        </div>
      )}

      <Composer
        t={t}
        streaming={streaming}
        settings={settings}
        onSettingsChange={onSettingsChange}
        onPickWorkspace={onPickWorkspace}
        onSend={onSend}
        onStop={onStop}
        initialText={quoteDraft}
        onConsumed={() => setQuoteDraft("")}
      />
    </main>
  );
}

function EmptyState({ t, appName, onPick }: { t: (key: string) => string; appName: string; onPick: (text: string) => void }): React.JSX.Element {
  const cards = [
    { icon: Rocket, iconClass: "text-sky-500", titleKey: "chat.card.explore.title", prompt: t("chat.suggestion.arch") },
    { icon: Wrench, iconClass: "text-violet-500", titleKey: "chat.card.build.title", prompt: t("chat.suggestion.code") },
    { icon: GitPullRequestArrow, iconClass: "text-emerald-500", titleKey: "chat.card.review.title", prompt: "帮我审查一下这段实现" },
    { icon: Bug, iconClass: "text-amber-500", titleKey: "chat.card.fix.title", prompt: t("chat.suggestion.hello") },
  ];

  return (
    <div className="flex h-full min-h-96 flex-col items-center justify-center gap-8 pt-16 text-center">
      <div className="card grid size-12 place-items-center rounded-full text-(--color-app-muted)">
        <span aria-hidden className="text-lg">◠‿◠</span>
      </div>
      <h1 className="max-w-lg text-[clamp(19px,2.4vw,24px)] font-medium">
        {t("chat.empty.title").replace("InnocenceCode", appName)}
      </h1>
      <div className="grid w-full grid-cols-2 gap-3 min-[1100px]:grid-cols-4">
        {cards.map(({ icon: Icon, iconClass, titleKey, prompt }) => (
          <button
            key={titleKey}
            type="button"
            onClick={() => onPick(prompt)}
            className="card flex flex-col items-start gap-2.5 p-3.5 text-left text-sm transition-all hover:-translate-y-0.5 hover:shadow-(--shadow-pop)"
          >
            <Icon size={18} className={iconClass} />
            <span className="leading-snug text-(--color-app-text)">{t(titleKey)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
