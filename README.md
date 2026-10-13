# pi-session-memory

为 Pi 提供轻量的跨会话文件记忆。当前 Agent 在工作中保存值得复用的信息，新对话通过简短索引找到相关主题。记忆都是普通 Markdown，可以直接阅读、修改或删除。

借鉴 Claude Code auto memory 的基本方式：**一个索引 + 按主题保存的文件 + 宿主已有的读写工具**。扩展只准备目录并载入索引，不扫描历史会话、不启动后台模型任务。

## 安装

需要 Pi 0.86.1+、Node.js 22.19+。

```bash
pi install git:github.com/yungyu16/pi-session-memory
```

安装后执行 `/reload` 或重启 Pi。默认跟随 `main`，获取更新使用：

```bash
pi update git:github.com/yungyu16/pi-session-memory
```

本包通过 Git 分发，保留 `private: true` 以防意外发布 npm；不依赖个人配置仓库。

## 怎么使用

照常与 Pi 工作即可。提示词允许 Agent 在发现可复用的偏好、纠正、决策背景或参考入口时主动记录；也可以直接说：

- “记住：这个项目的集成测试需要本地 Redis。”
- “看看之前对这个配置问题的记录。”
- “那条约定过时了，改成现在的做法。”

是否主动保存取决于当前模型的判断，不保证每次会话都会产生记忆。明确要求记住重要事项更可靠。

默认目录：

```text
~/.agents/memory/
├── MEMORY.md            # 一行一个主题链接的索引
└── topics/
    ├── 项目A-测试约定.md
    └── 用户偏好.md
```

每次发送消息前，扩展读取最新 `MEMORY.md`，最多载入前 200 行、25000 UTF-8 字节；超出部分仍保存在磁盘，并提示 Agent 精简索引。主题正文通过 Pi 的 `read`、`edit`、`write` 及搜索工具按需处理，不会全部塞进上下文。

## 开关与配置

| 入口 | 用途 |
| --- | --- |
| `/memory` / `/memory status` | 查看开关状态和记忆目录 |
| `/memory on` / `/memory off` | 开启或关闭后续记忆提示 |
| `--no-memory` / `PI_MEMORY=0` | 启动时关闭 |
| `PI_MEMORY_DIR` | 设置记忆根目录，默认 `~/.agents/memory/` |

仅在 TUI 持久会话启用。开关不持久化；关闭不删除文件，也不是阻止模型访问文件的权限机制。具体设置、存储和维护见 [使用与存储](docs/使用与存储.md)。

## 行为边界

扩展不发起独立模型请求。Agent 读写记忆属于正常会话，消耗当前对话的上下文与费用。

记忆由模型维护，可能遗漏或写错；重要结论仍应核对当前源码和证据。提示词要求不保存凭据，并保留项目范围、日期和验证状态。文件可由用户直接维护，扩展不会自动回收或覆盖它们。

默认目录跨项目共享，项目相关记忆应在文件名和正文中注明范围。实现取舍见 [设计](docs/设计.md)。

## 开发与验证

使用 `.nvmrc` 指定的 Node.js 版本：

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

测试使用临时目录，覆盖索引载入、字符边界、即时刷新、开关、运行模式、错误提示和 Pi loader。不调用真实模型、不修改真实记忆；模型是否主动正确保存记忆，以及本机 TUI 表现，需要真实使用验收。

入口是 `src/index.ts`，由 `pi.extensions` 显式注册。Pi SDK 由宿主提供，开发验证显式固定 Pi SDK 相关包的版本，保证 loader 使用一致的 SDK；无独立运行时第三方依赖。TypeScript 和提示词随包分发，无需编译。

## 许可证

[MIT](LICENSE)。
