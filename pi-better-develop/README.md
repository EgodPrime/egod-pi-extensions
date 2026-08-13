# pi-better-develop

一个 pi 扩展,把三个工作模式合并到一个包里:默认只读,**写权限按需开放**,并提供「写计划文件」的专属能力。

| 模式 | 写权限 | 用途 |
|------|--------|------|
| **chat**(默认) | 无(只读) | 只读讨论/审阅;`edit`/`write` 禁用,`bash` 仅白名单只读命令 |
| **plan** | 仅 `./.pi/plans/` | 写计划文件;通过专属 `write_plan` 工具,内置 `edit`/`write` 仍禁用 |
| **dev** | 全盘 | 完整开发;恢复内置 `edit`/`write` |

## 命令面

| 命令 | 作用 |
|------|------|
| `/chat` | 进入只读 chat 模式;**从 dev 或 plan 退出都走它**(替代旧 `/devoff` 与 `/plan end`) |
| `/plan` | 进入 plan 模式(仅可写 `.pi/plans/`);注入 idea.md 计划上下文 |
| `/dev` | 进入 dev 模式(全写权限) |

## 行为说明

- **每轮注入权威模式标记到系统提示**:系统提示每轮重建,只保留一条**始终反映当前状态**的标记,`/chat` 后旧模式不会再残留——模型不会继续以旧模式自居。
- **每轮强制工具集对齐**:`before_agent_start` 按当前模式强制 `setActiveTools`,即使之前工具被清掉,/dev 或 /plan 一开下一轮立刻恢复对应写能力。
- **checklist 回填提醒**:plan 上下文(`assets/idea.md`)强制每个计划文件携带完整《检查清单》并随时与正文/状态同步;dev 模式每轮注入 `CHECKLIST_NOTE`,提醒实现/修订后回填对应计划文件的检查清单、状态与偏离记录,避免 checklist 陈旧。
- **plan 只写 plans 目录**:`write_plan` 后端做路径 resolve + containment 校验,越界/穿越(`..`)路径直接拒绝,写权限真正锁死在 `./.pi/plans/`。
- **bash 白名单闸门**(chat/plan):只放行只读「查看」命令(`ls/cat/pwd/find/grep/rg/head/tail/wc/stat/file/tree/du/df/more/less/sed`、`git` 只读子命令、`ps` 等系统查看),支持 `|` 管道按段各自校验组合;写重定向、命令替换、`;`/`&&`/`||` 与未列出的命令一律**直接 block** **不再弹 UI 请示**。dev 模式全放行。
- **状态仅会话内生效**:新会话/恢复/分叉一律回到默认 chat(只读)。
- 底部状态栏三态:`⏸ chat (read-only)` / `📋 plan` / `⚒ dev`。

## 使用方式

**方式 A:直接测试(不用安装)**

```bash
pi -e ./index.ts
```

**方式 B:自动发现(推荐)**

把 `index.ts` 放到自动发现目录,然后 `/reload`:
- 全局:`~/.pi/agent/extensions/`
- 项目本地:`.pi/extensions/`

**方式 C:作为 pi 包安装**

```bash
pi install /home/egod/Projects/pi-better-develop
```

安装后建议移除旧的 `dev-mode` 与 `pi-plan-mode` 两个安装(见「替换旧扩展」)。

## 替换旧扩展

新包合并了旧 `dev-mode`(只读默认 + /dev//devoff)与 `pi-plan-mode`(/plan 注入 idea.md)。安装并验证新包后:

1. 卸载旧包:
   ```bash
   pi uninstall dev-mode
   pi uninstall pi-plan-mode
   ```
   或在 `~/.pi/agent/settings.json` 的 `packages` 里删除 `../../Projects/dev-mode` 与 `../../Projects/pi-plan-mode` 两条目。
2. `pi install ../../Projects/pi-better-develop`
3. 确认 `~/.pi/agent/extensions/` 下无旧的 `chat-dev-mode.ts` 等自动发现文件,然后 `/reload`。

## 验证

类型检查(本地已搭好 node_modules 解析环境):

```bash
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
- 参考示例:`examples/extensions/plan-mode/`、`examples/extensions/tools.ts`、`examples/extensions/dynamic-tools.ts`