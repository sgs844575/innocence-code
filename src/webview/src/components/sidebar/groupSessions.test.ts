// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Session } from "../../../../shared/ipc";
import { groupSessions, projectColor, projectName } from "./groupSessions";

const s = (id: string, ws: string, updatedAt: number): Session => ({
  id, title: id, createdAt: updatedAt, updatedAt, messageCount: 1, workspaceRoot: ws,
});

describe("groupSessions", () => {
  it("按 workspaceRoot 分组，组间按最新会话倒序，组内按 updatedAt 倒序", () => {
    const groups = groupSessions(
      [s("a1", "D:/x/alpha", 10), s("b2", "D:/y/beta", 30), s("a2", "D:/x/alpha", 20), s("b1", "D:/y/beta", 5)],
      "不在项目中",
    );
    expect(groups.map((g) => g.name)).toEqual(["beta", "alpha"]);
    expect(groups[0]!.sessions.map((x) => x.id)).toEqual(["b2", "b1"]);
    expect(groups[1]!.sessions.map((x) => x.id)).toEqual(["a2", "a1"]);
  });
  it("空 workspaceRoot 落入兜底组且恒排最后", () => {
    const groups = groupSessions([s("n1", "", 99), s("a1", "D:/x/alpha", 1)], "不在项目中");
    expect(groups.map((g) => g.name)).toEqual(["alpha", "不在项目中"]);
    expect(groups[1]!.key).toBe("");
  });
  it("全空 = 只有兜底组；无会话 = 空数组", () => {
    expect(groupSessions([s("n", "", 1)], "不在项目中").map((g) => g.name)).toEqual(["不在项目中"]);
    expect(groupSessions([], "不在项目中")).toEqual([]);
  });
  it("projectName 取 basename（兼容反斜杠）；projectColor 对同路径稳定", () => {
    expect(projectName("D:\\Projects\\AiProjects\\InnocenceCode")).toBe("InnocenceCode");
    expect(projectColor("D:/a") === projectColor("D:\\a")).toBe(true); // 大小写/斜杠归一
    expect(typeof projectColor("D:/a")).toBe("string");
  });
});
