import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatPermissionEvent, HarnessSettings, PermissionChoice } from "../../../shared/ipc";
import { MessageItem } from "./MessageItem";
import { Composer } from "./Composer";
import { PermissionCard } from "./PermissionCard";
import { ProjectPicker, type RecentProject } from "./composer/ProjectPicker";

interface Props {
  t: (key: string) => string;
  appName: string;
  messages: ChatMessage[];
  streaming: boolean;
  settings: HarnessSettings | null;
  permission: ChatPermissionEvent | null;
  onSettingsChange: (patch: Partial<HarnessSettings>) => void;
  onPermissionRespond: (requestId: string, choice: PermissionChoice) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /** 落地态（无激活会话）：输入面板垂直居中 + 顶部项目选择行。 */
  landing: boolean;
  /** 落地态选中的项目（"" = 不在项目中）。 */
  pendingProject: string;
  onPickProject: (workspaceRoot: string) => void;
  recentProjects: RecentProject[];
  /** 「打开项目…」系统目录选择器（结果进落地态选择，不直接改全局）。 */
  onOpenProjectDir: () => void;
}

export function ChatView({
  t,
  appName,
  messages,
  streaming,
  settings,
  permission,
  onSettingsChange,
  onPermissionRespond,
  onSend,
  onStop,
  landing,
  pendingProject,
  onPickProject,
  recentProjects,
  onOpenProjectDir,
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
    if (!pinned) return;
    // 流式期间必须瞬时贴底：smooth 动画的终点是"动画开始时的底部"，
    // 而流式内容在动画窗口内持续增长，动画永远追不上 → 视口总差一点。
    // 瞬时滚动每次都精确落底；非流式变化（切会话/首载）保留 smooth 手感。
    bottomRef.current?.scrollIntoView({ behavior: streaming ? "auto" : "smooth", block: "end" });
  }, [messages, pinned, streaming]);

  // 落地态（无激活会话）：输入面板垂直居中 + 顶部项目选择行；不渲染消息区。
  if (landing) {
    return (
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex flex-1 items-center justify-center px-[clamp(12px,3vw,24px)] pb-24">
          <div className="w-full max-w-2xl">
            <h1 className="mb-4 text-center text-[clamp(17px,2vw,21px)] font-medium">
              {t("chat.empty.title").replace("InnocenceCode", appName)}
            </h1>
            <Composer
              t={t}
              streaming={streaming}
              settings={settings}
              onSettingsChange={onSettingsChange}
              onSend={onSend}
              onStop={onStop}
              header={
                <ProjectPicker
                  t={t}
                  value={pendingProject}
                  recent={recentProjects}
                  onSelect={onPickProject}
                  onOpenProject={onOpenProjectDir}
                />
              }
            />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="scrollbar-thin flex-1 overflow-y-auto">
        <div className="chat-column px-[clamp(12px,3vw,24px)] pb-6">
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
        onSend={onSend}
        onStop={onStop}
        initialText={quoteDraft}
        onConsumed={() => setQuoteDraft("")}
      />
    </main>
  );
}
