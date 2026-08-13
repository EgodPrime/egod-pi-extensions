# egod-pi-extensions

Egod 自用的 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 拓展集合。

## 相关文章

- [《pi agent:又一个少即是多的典范》](./blog/pi-agent-less-is-more.md) —— 用这套拓展写成的使用体验长文：全程以 pi-better-develop 的 `plan` + `dev` 模式完成，一篇"少即是多"的实践。

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

以下三种方式任选其一,把需要的扩展装进 pi。可只装其中一个,也可全部安装。**全局安装**对所有项目生效,**项目本地安装**只对当前项目生效。

> 安全提示:pi 扩展以你的完整系统权限运行,可执行任意代码。本仓库为自用扩展,安装前请自行审阅源码。

### 推荐预装

开始使用前,建议先安装以下两个第三方扩展(全局安装,所有项目生效):

```bash
# 交互式提问锚点:让 agent 在关键分叉点主动询问你的选择(与扩展对话交互配合良好)
pi install npm:@juicesharp/rpiv-ask-user-question

# 更易用的自定义 provider:更简洁地配置/接入自定义模型服务商
pi install npm:better-custom
```

装完后进入 pi 交互界面,运行 `/reload` 生效。如需仅项目本地安装,在命令后加 `-l`(如 `pi install -l npm:better-custom`)。

### 方式 A:自动发现(推荐,改动即热重载)

把扩展**目录**放到自动发现位置:`index.ts`(或整目录)放到以下路径后,重启或在 pi 内运行 `/reload` 即可生效,之后修改代码可用 `/reload` 热加载:

- 全局(所有项目):`~/.pi/agent/extensions/`
- 项目本地(仅当前项目):`.pi/extensions/`

例如全局安装全部四个扩展:

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi-better-develop/  ~/.pi/agent/extensions/
cp -r pi-mood/            ~/.pi/agent/extensions/
cp -r pi-token-speed/     ~/.pi/agent/extensions/
cp -r pi-user-profile/    ~/.pi/agent/extensions/
```

装好后进入 pi 交互界面,运行 `/reload`。

### 方式 B:作为 pi 包安装(推荐用于长期使用)

通过 `pi install` 将扩展作为包加入 `settings.json`(默认写入全局 `~/.pi/agent/settings.json`,加 `-l` 写入项目 `.pi/settings.json`):

```bash
# 全局安装(所有项目)
pi install /absolute/path/to/pi-better-develop
pi install /absolute/path/to/pi-mood
pi install /absolute/path/to/pi-token-speed
pi install /absolute/path/to/pi-user-profile

# 或仅项目本地
pi install -l ./pi-better-develop
```

查看已安装: `pi list`;卸载: `pi remove /path/...`。

> 说明:本项目各子目录的 `package.json` 已声明 `pi.extensions` 入口(`./index.ts`),因此可直接作为 pi 包安装。若后续发布到 npm/git,也可改用 `pi install npm:...` 或 `pi install git:...`。

### 方式 C:临时测试(不安装)

单独跑一个扩展做验证,不写入任何配置:

```bash
pi -e ./pi-better-develop/index.ts
pi -e ./pi-mood/index.ts
```

> 注意:自动发现目录(方式 A)中的扩展支持 `/reload` 热加载;方式 C 仅用于临时验证,改代码需重启 pi。

### 三种方式的区别

| 方式 | 命令 | 写入配置 | 热重载 `/reload` | 适用场景 |
|------|------|----------|-----------------|----------|
| A 自动发现 | 复制到 `extensions/` | 否 | ✅ | 日常开发/调试扩展 |
| B pi 包 | `pi install <路径>` | ✅ `settings.json` | ✅ | 长期稳定使用、分享 |
| C 临时 | `pi -e ./index.ts` | 否 | ❌ | 快速验证单个扩展 |

### 各扩展的使用命令

| 扩展 | 安装后使用方法 |
|------|----------------|
| `pi-better-develop` | `/chat` `/plan` `/dev` 切换工作模式 |
| `pi-mood` | `/mood [user\|model\|on\|off\|memory]` 情绪吐槽 |
| `pi-token-speed` | 无需操作,页脚自动显示 tok/s |
| `pi-user-profile` | `/figureme` 问卷初始化,`/profile` 查看管理 |

详细说明见各子目录的 `README.md`。