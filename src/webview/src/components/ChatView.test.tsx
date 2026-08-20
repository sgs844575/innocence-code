// @vitest-environment jsdom
// C3 (final review): the chat surface consumes the review view model.
//   - taskChanges (task:changes -> summarizeChanges) renders TaskChangeCard
//     on the keyed message, and the 审查 action fires onOpenTaskReview.
//   - onForkMessage renders the message fork affordances (user: 编辑并创建
//     路线; assistant: 重试并创建路线) with the message id as the turn id.
//   - the fork entry mounts ForkRouteDialog through the App-shaped wiring
//     (state -> dialog -> createRoute/onSwitchRoute).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../../shared/ipc";
import type { TaskForkRouteRequest } from "../../../shared/taskIpc";
import { ChatView } from "./ChatView";
import { ForkRouteDialog } from "./task/ForkRouteDialog";
import type { ForkMessageCommand } from "./MessageItem";

// jsdom has no layout: the bottom-anchor scroll is a no-op in tests.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

import { zhCN } from "../lib/i18n";
const t = (key: string) => zhCN[key] ?? key;

function message(overrides: Partial<ChatMessage> & { id: string; role: "user" | "assistant" }): ChatMessage {
  return {
    parts: [{ type: "text", text: "hello" }],
    createdAt: 1,
    ...overrides,
  } as ChatMessage;
}

const messages: ChatMessage[] = [
  message({ id: "msg_user_1", role: "user" }),
  message({ id: "msg_asst_1", role: "assistant", streaming: false }),
];

afterEach(cleanup);

describe("ChatView review wiring (C3)", () => {
  it("renders TaskChangeCard for the keyed message and fires the review action", () => {
    const onOpenTaskReview = vi.fn();
    render(
      <ChatView
        t={t}
        appName="InnocenceCode"
        messages={messages}
        streaming={false}
        settings={null}
        permission={null}
        onSettingsChange={() => {}}
        onPermissionRespond={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        landing={false}
        pendingProject=""
        onPickProject={() => {}}
        recentProjects={[]}
        onOpenProjectDir={() => {}}
        taskChanges={{
          msg_asst_1: {
            summary: { fileCount: 2, added: 7, removed: 3, accepted: 1, pending: 1, restored: 0, conflicts: 0, unreviewed: 1 },
            checkpointId: "ckpt_1",
            validation: null,
          },
        }}
        onOpenTaskReview={onOpenTaskReview}
      />,
    );
    // The change card renders on the keyed assistant message: 2 个文件 (+7/−3)
    // and the checkpoint id from the view model.
    expect(screen.getByText("2 个文件")).toBeTruthy();
    expect(screen.getByText("+7")).toBeTruthy();
    expect(screen.getByText("−3")).toBeTruthy();
    expect(screen.getByText("ckpt_1")).toBeTruthy();
    // The 审查 button is enabled and reports the keyed message.
    fireEvent.click(screen.getByRole("button", { name: "审查" }));
    expect(onOpenTaskReview).toHaveBeenCalledWith("msg_asst_1");
  });

  it("renders fork affordances through onForkMessage with the message id as turn id", () => {
    const onForkMessage = vi.fn();
    render(
      <ChatView
        t={t}
        appName="InnocenceCode"
        messages={messages}
        streaming={false}
        settings={null}
        permission={null}
        onSettingsChange={() => {}}
        onPermissionRespond={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        landing={false}
        pendingProject=""
        onPickProject={() => {}}
        recentProjects={[]}
        onOpenProjectDir={() => {}}
        onForkMessage={onForkMessage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑并创建路线" }));
    expect(onForkMessage).toHaveBeenCalledWith({
      turnId: "msg_user_1",
      mode: "edit-user",
      text: "hello",
    } satisfies ForkMessageCommand);
    fireEvent.click(screen.getByRole("button", { name: "重试并创建路线" }));
    expect(onForkMessage).toHaveBeenCalledWith({
      turnId: "msg_asst_1",
      mode: "retry-assistant",
      text: "hello",
    } satisfies ForkMessageCommand);
    // Without the callback the affordances never render.
    cleanup();
    render(
      <ChatView
        t={t}
        appName="InnocenceCode"
        messages={messages}
        streaming={false}
        settings={null}
        permission={null}
        onSettingsChange={() => {}}
        onPermissionRespond={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        landing={false}
        pendingProject=""
        onPickProject={() => {}}
        recentProjects={[]}
        onOpenProjectDir={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "编辑并创建路线" })).toBeNull();
    expect(screen.queryByRole("button", { name: "重试并创建路线" })).toBeNull();
  });
});

/** App-shaped fork wiring: onForkMessage -> state -> ForkRouteDialog. */
function ForkHarness() {
  const [fork, setFork] = useState<{ request: TaskForkRouteRequest; checkpointId: string } | null>(null);
  const [switched, setSwitched] = useState<string | null>(null);
  const onForkMessage = (next: ForkMessageCommand) => {
    setFork({
      request: {
        sessionId: "s1",
        taskId: "t1",
        sourceRouteId: "main",
        sourceTurnId: next.turnId,
        mode: next.mode,
        ...(next.mode === "edit-user" ? { editedText: next.text } : {}),
        routeName: next.mode === "edit-user" ? `Edit ${next.turnId}` : `Retry ${next.turnId}`,
      },
      checkpointId: "ckpt_1",
    });
  };
  return (
    <div>
      <ChatView
        t={t}
        appName="InnocenceCode"
        messages={messages}
        streaming={false}
        settings={null}
        permission={null}
        onSettingsChange={() => {}}
        onPermissionRespond={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        landing={false}
        pendingProject=""
        onPickProject={() => {}}
        recentProjects={[]}
        onOpenProjectDir={() => {}}
        onForkMessage={onForkMessage}
      />
      {fork && (
        <ForkRouteDialog
          open
          request={fork.request}
          checkpointId={fork.checkpointId}
          onClose={() => setFork(null)}
          createRoute={async (request) => ({
            routeId: "route_fork",
            parentRouteId: "main",
            forkTurnId: request.sourceTurnId,
            checkpointId: "ckpt_fork",
            workspaceKind: "git",
            prompt: "forked prompt",
          })}
          onSwitchRoute={(routeId, prompt) => setSwitched(`${routeId}:${prompt}`)}
        />
      )}
      {switched && <div data-testid="switched">{switched}</div>}
    </div>
  );
}

describe("fork entry to ForkRouteDialog (C3)", () => {
  it("mounts the dialog from the message entry and drives create -> switch", async () => {
    render(<ForkHarness />);
    fireEvent.click(screen.getByRole("button", { name: "重试并创建路线" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy(); // parent route row
    fireEvent.click(screen.getByRole("button", { name: "创建路线" }));
    expect((await screen.findByTestId("switched")).textContent).toBe("route_fork:forked prompt");
    // The dialog closes after a successful create.
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
