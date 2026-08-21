# pi-better-develop

一个 pi 扩展,把三个工作模式合并到一个包里:默认只读,**写权限按需开放**,并提供「写计划文件」的专属能力。

| 模式 | 写权限 | 用途 |
|------|--------|------|
| **chat**(默认) | 无(只读) | 只读讨论/审阅;`edit`/`write` 禁用,`bash` 可用但通过系统提示约束不写盘 |
| **plan** | 仅 `./.pi/plans/` | 写计划文件;通过专属 `write_plan` 工具,内置 `edit`/`write` 仍禁用 |
| **dev** | 全盘 | 完整开发;恢复内置 `edit`/`write` |

## 命令面

| 命令 | 作用 |
|------|------|
| `/chat` | 进入只读 chat 模式;从 dev 或 plan 退出都走它 |
| `/plan` | 进入 plan 模式(仅可写 `.pi/plans/`);注入 idea.md 计划上下文 |
| `/dev` | 进入 dev 模式(全写权限) |

## 行为说明

- **每轮注入权威模式标记到系统提示**:系统提示每轮重建,只保留一条**始终反映当前状态**的标记,`/chat` 后旧模式不会再残留——模型不会继续以旧模式自居。
- **每轮强制工具集对齐**:`before_agent_start` 按当前模式强制 `setActiveTools`,即使之前工具被清掉,/dev 或 /plan 一开下一轮立刻恢复对应写能力。
- **checklist 回填提醒**:plan 上下文(`assets/idea.md`)强制每个计划文件携带完整《检查清单》并随时与正文/状态同步;dev 模式每轮注入 `CHECKLIST_NOTE`,提醒实现/修订后回填对应计划文件的检查清单、状态与偏离记录,避免 checklist 陈旧。
- **plan 只写 plans 目录**:`write_plan` 后端做路径 resolve + containment 校验,越界/穿越(`..`)路径直接拒绝,写权限真正锁死在 `./.pi/plans/`。
- **bash 不做代码级拦截**(chat/plan):不再用命令白名单硬 block。`bash` 在三种模式下均可自由使用;但 chat/plan 每轮通过系统提示(`CHAT_NOTE`/`PLAN_NOTE`)提醒 agent **不要用 bash 做写操作**(`>`,`>>`,`rm`,`mv`,`sed -i`,`git commit` 等),软约束靠模型遵循,不强制拦截。dev 模式全放行。
- **状态仅会话内生效**:新会话/恢复/分叉一律回到默认 chat(只读)。
- 底部状态栏三态:`⏸ chat (read-only)` / `📋 plan` / `⚒ dev`。

## 使用方式

全局安装(对所有项目生效):

```bash
pi install /absolute/path/to/pi-better-develop
```

装好后进入 pi 交互界面,运行 `/reload` 生效(之后改代码也可 `/reload` 热加载)。

## 验证

类型检查依赖本地的类型解析环境(`node_modules/` 与 `.typecheck/` 为符号链接,指向 pi 全局安装,已被 `.gitignore` 排除)。首次克隆后先补齐环境,再跑类型检查:

```bash
pi-better-develop$ mkdir -p node_modules/@earendil-works .typecheck/node_modules/@earendil-works
pi-better-develop$ ln -sfn /Users/ashu/.local/lib/node_modules/@earendil-works/pi-coding-agent node_modules/@earendil-works/pi-coding-agent
pi-better-develop$ ln -sfn /Users/ashu/.local/lib/node_modules/@earendil-works/pi-coding-agent .typecheck/node_modules/@earendil-works/pi-coding-agent
pi-better-develop$ ln -sfn /Users/ashu/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox node_modules/typebox
pi-better-develop$ npm run typecheck
```

## 结构

```
pi-better-develop/
├── index.ts               # 扩展入口(默认导出 factory)
├── assets/
│   ├── idea.md            # plan 模式注入的计划上下文
│   └── templates/plan.md  # 计划模板
├── package.json           # name: pi-better-develop + typecheck 脚本
├── tsconfig.typecheck.json
├── node_modules/          # 本地类型检查解析辅助(符号链接指向 pi 安装)
└── .gitignore
```

## 参考

- 文档:`docs/extensions.md`(`setActiveTools`、`registerCommand`、`registerTool`、`before_agent_start` 系统提示注入)
- 参考示例(pi SDK 自带):`examples/extensions/plan-mode/`、`examples/extensions/tools.ts`、`examples/extensions/dynamic-tools.ts`