# secure-storage-node — 私有磁盘存储基元

`@innocencecode/secure-storage-node` 提供任务数据的私有存储地基：给定根目录，创建即加固——
POSIX 上目录 0700 / 文件 0600，Windows 上用 `icacls` 收紧为仅当前用户可访问。
只做路径管理与安全文件原语，不含任何任务域知识。

## 作用

- **openSecureStorage(rootDir)**：打开（缺则创建）加固根，每次打开重加固根目录；可预建固定子目录布局
  （`objects / checkpoints / events / backup / temp / apply-journal / locks/...`）。
- **安全文件原语**：`writeFile`（0600 + fsync）、`writeFileAtomic`（temp 写 + fsync + rename）、
  `appendFile`（fsync）、`createFileExclusive`（temp + `link()` 原子发布，EEXIST 即他人已赢——
  目标永不可能被观察到空/半内容，跨进程锁就建立在这上面）。
- **路径纪律**：所有入口路径必经 `isSafeRelativePath` 校验（"/" 分隔、拒 `..` / 反斜杠 / 绝对路径 / 盘符 / NUL，
  长度 ≤1024），越根即抛 `unsafe relative path`。

## 公开 API（节选）

| 导出 | 说明 |
|---|---|
| `openSecureStorage(rootDir, options?)` | 打开/创建加固根 → `SecureStorage` |
| `SecureStorage` | `root / ensureDir / resolve / subdir / createTempDir / writeFile / writeFileAtomic / appendFile / createFileExclusive / readFile / readTextFile / fileExists / deleteFile / listDir` |
| `SECURE_SUBDIRS` | 固定子目录布局（任务系统 P1 约定） |
| `isSafeRelativePath(rel)` | 相对路径合法性校验 |
| `currentProcessSid(exec?)` | 解析当前用户 SID（Windows，进程内缓存） |

`SecureStorageOptions`：`dirs?`（预建子目录）、`platform? / execFile? / windowsSid?`（测试注入缝）。

## 使用

```ts
import { openSecureStorage } from "@innocencecode/secure-storage-node";

const storage = await openSecureStorage(path.join(userData, "tasks")); // 创建即加固
const file = storage.resolve("events/app.log");                        // 越界路径在这里就会抛错
await storage.appendFile("events/app.log", line + "\n");               // fsync 追加
const created = await storage.createFileExclusive(`locks/task/${key}.lock`, ownerJson); // 原子抢占
```

实际消费者是任务族包：`task-workspace`（任务根 + 锁存储，见 `private-task-storage.ts`）与
`task-cli`（锁目录），Electron 宿主经任务桥间接使用；`src/main/codeReader.ts` 也复用
`isSafeRelativePath` 校验路由相对路径。

## 关键行为与约束

- POSIX 创建后显式 chmod（umask 无论放宽/收紧都被击败）；Windows 对新建目录段执行
  `icacls <dir> /inheritance:r /grant:r *<SID>:(OI)(CI)(F)`，文件继承 ACL。
- 逐段 mkdir，仅对"本进程新建"的段加固；并发 EEXIST 视为他进程已加固。
- `writeFileAtomic` / `createFileExclusive` 的 temp 都放在同卷（保证 rename/link 原子性）。
- `resolve` 只做越界检查，绝不创建目录。

## 测试

```bash
npx vitest run packages/secure-storage-node
```

`tests/private-path.test.ts` 覆盖加固、路径校验与原子原语（含平台注入的分支测试）。
