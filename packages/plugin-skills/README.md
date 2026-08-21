# plugin-skills — SKILL.md 加载器插件

`@innocencecode/plugin-skills` 在激活时扫描技能目录，解析每个 `SKILL.md` 的 frontmatter（`name` / `description`），
把技能注册进 harness。设计是"描述常驻索引、正文按需注入"：frontmatter 描述进入技能索引表（自动附到系统提示词），
正文只在用户以 `/技能名` 调用时通过 `loadBody()` 注入上下文，不占用常驻 token。

## 作用

- 解析 `---` 分隔的 frontmatter（`key: value` 行）与正文，`name` 和 `description` 缺一不可，否则整文件跳过。
- 目录下每个子目录（内含 `SKILL.md`）或单个 `*.md` 文件都可以是一个技能。
- 目录不存在属正常情况（尚无技能），静默跳过；跨目录重名时首次注册胜出。

## 公开 API

| 导出 | 说明 |
|---|---|
| `createSkillsPlugin(options)` | 构造内核原生插件（name `skills`，`apply(ctx)`）；`options.dirs: string[]` |
| `parseSkillMarkdown(raw)` | 解析 SKILL.md 文本 → `{ name, description, body } \| null` |
| `ParsedSkillFile` / `SkillsPluginOptions` / `SkillsPlugin` | 解析结果与插件选项/形态类型 |

## 使用

技能文件（`.innocence/skills/<name>/SKILL.md`，放在工作区根）：

```markdown
---
name: review
description: 代码审查指南
---
审查时先看测试再看实现……（正文仅在 /review 调用时注入上下文）
```

宿主接线（`src/main/harnessGlue.ts`）：

```ts
import { createSkillsPlugin } from "@innocencecode/plugin-skills";

plugins.push(createSkillsPlugin({ dirs: [path.join(workspaceRoot, ".innocence", "skills")] }));
```

会话中输入 `/review` 即可调用该技能——`/name` 展开由本插件注册的首序 `MessageProcessor`
（name `skill-expansion`）在消息处理管线最前完成，正文替换语义与迁移前的会话内展开一致。
该插件在插件开关里的 id 是 `skills`（依赖 `fs`）。

## 关键行为与约束

- 扫描只发生在激活时刻——新增技能文件需新一轮会话生效。
- `loadBody` 返回解析时常驻的正文字符串（读取已在激活时完成），不会在会话中途再次读盘。
- 技能本身没有执行逻辑，只是"按需注入的提示词资产"。
- **子会话语义（有意接受）**：子代理会话按继承设计复制父会话的处理器
  （`harness-electron` session-spawner 的 `subagent-inherit`），因此以 `/技能名`
  开头的子代理 prompt 会在子会话内按**父会话的技能表**展开。方向无破坏性、
  触发面极窄（正常子代理 prompt 不以 `/` 开头），与处理器继承语义一致；
  若未来需要隔离，须改协议（继承集排除展开类处理器），本包不单独处理。

## 测试

```bash
npx vitest run packages/plugin-skills
```

`tests/skills.test.ts` 覆盖 frontmatter 解析、目录扫描、重名与缺目录容错。
