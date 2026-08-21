# egod-pi-extensions

Egod 自用的 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 拓展集合。

## 相关文章

- [《pi agent:又一个少即是多的典范》](./blog/pi-agent-less-is-more.md) —— 用这套拓展写成的使用体验长文：全程以 pi-better-develop 的 `plan` + `dev` 模式完成，一篇"少即是多"的实践。

## 扩展清单

| 扩展 | 说明 |
|------|------|
| [pi-better-develop](./pi-better-develop) | 三种工作模式：`/chat`(只读)、`/plan`(仅写 `.pi/plans`)、`/dev`(完全写) |
| [pi-mood](./pi-mood) | 情绪价值陪伴：页脚最右侧单行显示友善鼓励或常识小知识点(鼓励/知识各半，不攻击不抬杠)；联动 pi-user-profile，画像启用时个性化鼓励/知识点(未装/关闭则降级) |
| [pi-token-speed](./pi-token-speed) | 页脚状态栏实时显示生成速度(tok/s) |
| [pi-user-profile](./pi-user-profile) | 全局持久化用户画像 + `/figureme` 问卷,注入 system prompt |

## 开发

每个子目录是独立的 pi 拓展,通过 `package.json` 的 `pi.extensions` 字段声明入口 `index.ts`。

```bash
# 类型检查(各子目录内)
npm run typecheck
```

## 安装

通过 `pi install` 将扩展作为包**全局安装**(对所有项目生效),写入 `~/.pi/agent/settings.json`。可只装其中一个,也可全部安装。

> 安全提示:pi 扩展以你的完整系统权限运行,可执行任意代码。本仓库为自用扩展,安装前请自行审阅源码。

### 推荐预装

开始使用前,建议先安装以下三个第三方扩展(全局安装,所有项目生效):

```bash
# 交互式提问锚点:让 agent 在关键分叉点主动询问你的选择(与扩展对话交互配合良好)
pi install npm:@juicesharp/rpiv-ask-user-question

# 更易用的自定义 provider:更简洁地配置/接入自定义模型服务商
pi install npm:better-custom

# 网页访问:让 agent 具备联网搜索/读取网页的能力
pi install npm:pi-web-access
```

装完后进入 pi 交互界面,运行 `/reload` 生效。

### 全局安装本项目扩展

在本仓库根目录,用绝对路径对每个要装的扩展执行 `pi install`:

```bash
pi install /absolute/path/to/pi-better-develop
pi install /absolute/path/to/pi-mood
pi install /absolute/path/to/pi-token-speed
pi install /absolute/path/to/pi-user-profile
```

装好后进入 pi 交互界面,运行 `/reload` 生效;之后修改代码也可用 `/reload` 热加载。

查看已安装: `pi list`;卸载: `pi remove /path/...`。

> 说明:本项目各子目录的 `package.json` 已声明 `pi.extensions` 入口(`./index.ts`),因此可直接作为 pi 包全局安装。若后续发布到 npm/git,也可改用 `pi install npm:...` 或 `pi install git:...`。

### 各扩展的使用命令

| 扩展 | 安装后使用方法 |
|------|----------------|
| `pi-better-develop` | `/chat` `/plan` `/dev` 切换工作模式 |
| `pi-mood` | `/mood [user\|model\|on\|off\|memory]` 情绪吐槽 |
| `pi-token-speed` | 无需操作,页脚自动显示 tok/s |
| `pi-user-profile` | `/figureme` 问卷初始化,`/profile` 查看管理 |

详细说明见各子目录的 `README.md`。