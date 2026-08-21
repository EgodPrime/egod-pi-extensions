# pi-user-profile

全局持久化用户画像拓展。随你使用 pi,自动归纳你的偏好/办事风格/沟通习惯,并把画像注入到 agent 回答前的系统提示词中 —— 让 AI 越来越懂"你是怎么干活/喜欢的"。

## 特性

- **自动总结(节流)**:收集你的发言与对 AI 回答的反馈,攒够一定量或超时后,调用旁路 LLM 增量更新画像并持久化到全局。
- **`/figureme` 问卷**:按预设题目生成初始画像(支持自定义输入)。
- **系统提示词注入**:每回合把画像追加进系统提示词(每回合重建、无残留)。
- **自动 lint(画像质量守卫)**:
  - **结构校验**:JSON/schema/条目合法性,违规自动修复或记录。
  - **冲突调和**:检测矛盾、近重复、新旧冲突,LLM 调和为主,LLM 不可用时确定性兜底(去重合并 + 新取胜)。
  - **长度策略(双阈值)**:注入上下文 ≤**1024 tokens** 直接用原始画像;超 1024 才压缩,压缩目标压到 ≤**700 tokens**(压缩产物必须 ≤700);压缩仍无法达标时本回合禁用注入并提示。
- **控制面**:默认开启,全部数据只存本机。

## 安装

全局安装(对所有项目生效):

```bash
pi install /absolute/path/to/pi-user-profile
```

装好后进入 pi 交互界面,运行 `/reload` 生效(之后改代码也可 `/reload` 热加载)。

数据文件(`~/.pi/agent/extensions_data/pi-user-profile/`,顶层受 `PI_CODING_AGENT_DIR` 覆盖;目录规范为 agentDir/extensions_data/拓展名,首个写入自动创建):
- `user-profile.json` — 画像本体
- `profile-signals.json` — 待总结的信号缓冲

> 说明:2.0 起数据归入 `extensions_data/pi-user-profile/` 子目录,不再直接放 agent 根目录。若 agent 根目录存在早期版本遗留的 `user-profile.json` / `profile-signals.json`,2.0 不再读写它们(从新目录重新开始),旧文件原样保留,不影响使用。

## 命令

| 命令 | 说明 |
|---|---|
| `/figureme` | 预设备问卷生成/重写画像 |
| `/profile` | 查看当前画像 |
| `/profile status` | 开关、缓冲、上次总结、tokens、待处理项 |
| `/profile on` / `off` | 开启/关闭自动总结与注入 |
| `/profile lint` | 手动全量 lint(结构+冲突+长度) |
| `/profile compress` | 手动生成压缩摘要缓存 |
| `/profile reset` | 清空画像与缓冲 |
| `/profile edit <key> <内容>` | 手动追加一条(可选) |

`key` 取值:`language | domains | preferences | workStyle | communication | values | avoid`。

## 隐私

- 画像由你的对话内容归纳,默认开启。
- **所有数据只存储在本机** `~/.pi/agent/extensions_data/pi-user-profile/` 下,不外发、不云同步。
- 可随时 `/profile` 查看、`/profile reset` 清空、`/profile off` 关闭。

## 设计取舍

- 单一全局画像(不按项目拆分)。
- 长度校验为本地零成本估算;仅"超限压缩/冲突调和/增量总结"会调用 LLM,且都走旁路(独立会话,不写入当前对话上下文)。
- 冲突处理偏保守:不擅丢高置信信息;LLM 调和失败时用确定性规则兜底,不损坏现有数据。