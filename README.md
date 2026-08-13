# egod-pi-extensions

Egod 自用的 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 拓展集合。

## 扩展清单

| 扩展 | 说明 |
|------|------|
| [pi-better-develop](./pi-better-develop) | 三种工作模式：`/chat`(只读)、`/plan`(仅写 `.pi/plans`)、`/dev`(完全写) |
| [pi-mood](./pi-mood) | 情绪陪伴：每轮结束在页脚最右侧生成一句调侃/鼓励 |
| [pi-token-speed](./pi-token-speed) | 页脚状态栏实时显示生成速度(tok/s) |
| [pi-user-profile](./pi-user-profile) | 全局持久化用户画像 + `/figureme` 问卷,注入 system prompt |

## 开发

每个子目录是独立的 pi 拓展,通过 `package.json` 的 `pi.extensions` 字段声明入口 `index.ts`。

```bash
# 类型检查(各子目录内)
npm run typecheck
```

## 安装

将相应子目录(或其路径)加入 pi 的拓展配置即可。