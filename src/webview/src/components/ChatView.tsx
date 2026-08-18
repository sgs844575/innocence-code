import { useEffect, useRef } from "react";
import { Rocket, Wrench, GitPullRequestArrow, Bug } from "lucide-react";
import type { ChatMessage } from "../../../shared/ipc";
import { MessageItem } from "./MessageItem";
import { Composer } from "./Composer";

interface Props {
  t: (key: string) => string;
  appName: string;
  messages: ChatMessage[];
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function ChatView({ t, appName, messages, streaming, onSend, onStop }: Props): React.JSX.Element {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <div className="scrollbar-thin flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 pb-6">
          {messages.length === 0 ? (
            <EmptyState t={t} appName={appName} onPick={onSend} />
          ) : (
            <div className="space-y-5 pt-6">
              {messages.map((m) => (
                <MessageItem key={m.id} t={t} message={m} />
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <Composer
        t={t}
        appName={appName}
        streaming={streaming}
        onSend={onSend}
        onStop={onStop}
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
      <div className="grid size-12 place-items-center rounded-full border border-(--color-app-border) text-(--color-app-muted)">
        <span aria-hidden className="text-lg">◠‿◠</span>
      </div>
      <h1 className="max-w-lg text-2xl font-medium">
        {t("chat.empty.title").replace("InnocenceCode", appName)}
      </h1>
      <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map(({ icon: Icon, iconClass, titleKey, prompt }) => (
          <button
            key={titleKey}
            type="button"
            onClick={() => onPick(prompt)}
            className="flex flex-col items-start gap-2.5 rounded-xl border border-(--color-app-border) bg-(--color-app-panel) p-3.5 text-left text-sm transition-colors hover:bg-(--color-app-bubble)"
          >
            <Icon size={18} className={iconClass} />
            <span className="leading-snug text-(--color-app-text)">{t(titleKey)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
