/**
 * pi-mood — 情绪价值插件 (v3: 定时随机吐槽 + 身份化上下文 + 独立记忆)
 *
 * 触发机制:
 *   - 不由模型响应/回合事件触发, 而是**定时自动吐槽**。
 *   - 吐槽对象在「用户」与「模型」之间**随机**选择。
 *   - 挂机自适应间隔: 用户有动作保持 30s; 长时间无动作自动延长
 *     30s → 1m → 10m → 30m → 1h; 用户一有动作立即回到 30s。
 *
 * 身份化上下文(每次吐槽都喂给吐槽役, 无论吐槽谁):
 *   用户最近发言3次 + 用户最近斜杠命令3次 + Agent(模型)最新回复 + 吐槽役自己说过的话(分角色)。
 *   模型绝不会把「用户的发言」和「模型自己的回复」搞混。
 *
 * 独立记忆:
 *   - `pi.appendEntry("pi-mood-memory")` 持久化(custom entry, 不进入 LLM 上下文)。
 *   - 按目标分两类: 对用户说过的(toUser) / 对模型说过的(toModel), 防重复更精准。
 *
 * 会话隔离:
 *   - 生成走 `ctx.modelRegistry.complete()` 旁路调用, 不写 transcript、不占主对话。
 *     每次全新 sessionId + cacheRetention:none。
 *   - 只通过事件【读取】行为, 从不向会话【写入】(独立记忆除外)。
 *
 * 安装: ~/.pi/agent/extensions/ 或 .pi/extensions/, 然后 /reload。
 * 用法:
 *   /mood            立即随机吐槽一句
 *   /mood user|model 立即对指定对象吐槽一句
 *   /mood off|on     关闭/开启(关闭时定时吐槽暂停)
 *   /mood memory     列出当前独立记忆(分类)
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SPEECH_MAX = 3; // 用户最近发言条数
const OPS_MAX = 3; // 用户最近命令条数
const AGENT_REPLY_MAX = 500; // Agent 回复截断长度
const MEMORY_MAX = 8; // 每类(对用户/对模型)记忆条数
const COMMENT_MAX = 60;
const MEMORY_KEY = "pi-mood-memory"; // 独立记忆的 custom entry 类型
const STATUS_ID = "pi-mood"; // 状态行 key, 字母序排在最后
/** 挂机自适应吐槽间隔: 30s → 1m → 10m → 30m → 1h; 用户有新动作即回到 30s。 */
const LEVELS_MS = [30_000, 60_000, 600_000, 1_800_000, 3_600_000];

/** 身份化输入缓冲(仅内存) */
const userSpeech: string[] = [];
const userOps: string[] = [];

let agentReply = ""; // Agent(模型)最新回复文本
let mood = ""; // 当前展示的一句吐槽
let generating = false;
/** 分角色记忆: 对用户 / 对模型 说过的吐槽 */
let memory = { toUser: [] as string[], toModel: [] as string[] };

function pushList(list: string[], item: string, max: number): void {
  list.push(item);
  if (list.length > max) list.shift();
}

/** 从 assistant message 的 content parts 里提取纯文本 */
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return (content as { type?: string; text?: string }[])
    .filter((c) => c?.type === "text" && typeof c.text === "string" && c.text.length > 0)
    .map((c) => c.text as string)
    .join("\n")
    .trim();
}

const SYSTEM_TEMPLATE = `You are "情绪管家", a witty, warm companion living inside a coding tool.
You ALWAYS speak to the HUMAN USER in second person ("你…") — never address an abstract entity or a third party. Even when mocking the AI, you say it TO the user.

Your job: produce EXACTLY ONE short, lively, playful line, always addressed to the user ("你…"). The topic is given by TARGET below.

TARGET: {{TARGET}}
- If TARGET = "USER": tease or encourage the user based on their recent speech and slash commands (and what the AI just did). E.g. "你又…", "你这记性…".
- If TARGET = "MODEL": COMMENT on the AI assistant's latest reply (see AGENT latest reply below). Roast/tease its wording, verbosity, overconfidence, pedantry, clichés, or lack of self-awareness — but still say it TO the user, e.g. "你那位AI刚才绕得…", "你这位AI的话你也敢全信…".

Rules:
- Exactly one line. Second person, addressed to the user. No labels, no quotes, no markdown, no emoji.
- Aim ~6–24 characters (CJK) or 3–12 words (Latin). Match the user's language.
- NEVER repeat any line you already said, and NEVER re-tease a topic you already covered (see YOUR MEMORY below).

Context — identities are EXPLICIT, never mix them up:
[USER recent speech — said by the HUMAN, up to 3]
{{USER_SPEECH}}

[USER recent commands — slash commands the HUMAN ran, up to 3]
{{USER_OPS}}

[AGENT latest reply — said by the AI ASSISTANT]
{{AGENT_REPLY}}

[YOUR MEMORY — lines YOU (情绪管家) already said, by target. Do NOT repeat these or their topics.]
{{MEMORY}}

Reply with just the line.`;

async function runMood(ctx: ExtensionContext, pi: ExtensionAPI, t: "USER" | "MODEL"): Promise<void> {
  if (generating || !ctx.model) return;
  generating = true;
  try {
    const us = userSpeech.length ? userSpeech.join("\n") : "(暂无)";
    const ops = userOps.length ? userOps.join("\n") : "(暂无)";
    const agent = agentReply || "(模型还没开口)";
    const memLines: string[] = [];
    for (const m of memory.toUser) memLines.push(`MOOD▶USER : ${m}`);
    for (const m of memory.toModel) memLines.push(`MOOD▶MODEL: ${m}`);
    const mem = memLines.length ? memLines.join("\n") : "(暂无)";

    const systemPrompt = SYSTEM_TEMPLATE
      .replace("{{TARGET}}", t)
      .replace("{{USER_SPEECH}}", us)
      .replace("{{USER_OPS}}", ops)
      .replace("{{AGENT_REPLY}}", agent)
      .replace("{{MEMORY}}", mem);

    const resp = await ctx.modelRegistry.complete(
      ctx.model,
      {
        systemPrompt,
        messages: [{ role: "user", content: [{ type: "text", text: "来一句。" }], timestamp: Date.now() }],
      },
      {
        signal: ctx.signal,
        // 会话隔离保险: 全新 sessionId 避免与主对话共享 provider 缓存。
        sessionId: uuidv7(),
        cacheRetention: "none",
      },
    );
    const text = resp.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .replace(/\n+/g, " ")
      .trim();

    if (text) {
      mood = text.slice(0, COMMENT_MAX);
      if (t === "USER") {
        memory.toUser.push(mood);
        if (memory.toUser.length > MEMORY_MAX) memory.toUser.shift();
      } else {
        memory.toModel.push(mood);
        if (memory.toModel.length > MEMORY_MAX) memory.toModel.shift();
      }
      // 持久化独立记忆(custom entry, 不入 LLM 上下文)。
      pi.appendEntry(MEMORY_KEY, { toUser: [...memory.toUser], toModel: [...memory.toModel] });
    }
  } catch {
    // 失败则保留上一条, 静默
  } finally {
    generating = false;
  }
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  /** 供定时器使用的“最近一次”会话上下文 */
  let activeCtx: ExtensionContext | undefined;
  let moodTimer: ReturnType<typeof setInterval> | undefined;

  function renderMood(ctx: ExtensionContext): void {
    if (!enabled || !mood) {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", `◈ ${mood}`));
  }

  let idleIdx = 0; // 当前间隔档位(0 = 30s)
  let acted = true; // 本间隔内用户是否有动作(初始 true, 启动即 30s)
  let pendingToken = 0; // 用于使过期回调失效(重新调度后旧回调不执行)

  /** 自维持的 setTimeout 链: 到点吐槽 → 按挂机情况调整下一档 → 再次调度 */
  function scheduleNext(): void {
    const token = ++pendingToken;
    if (moodTimer !== undefined) clearTimeout(moodTimer);
    moodTimer = setTimeout(() => {
      if (token !== pendingToken) return; // 已被重置/停止, 丢弃
      moodTimer = undefined;
      // 本轮有动作 → 回到 30s; 全程挂机 → 升一档(上限 1h)
      idleIdx = acted ? 0 : Math.min(idleIdx + 1, LEVELS_MS.length - 1);
      acted = false;
      if (enabled && !generating && activeCtx) {
        // 对象随机: 用户 / 模型 各一半
        const t: "USER" | "MODEL" = Math.random() < 0.5 ? "USER" : "MODEL";
        void runMood(activeCtx, pi, t).then(() => renderMood(activeCtx!));
      }
      scheduleNext();
    }, LEVELS_MS[idleIdx]);
  }

  /** 用户有新动作: 间隔立即重置为 30s 并重新计时 */
  function resetSchedule(): void {
    idleIdx = 0;
    acted = true;
    scheduleNext();
  }

  function startTimer(): void {
    stopTimer();
    idleIdx = 0;
    acted = true;
    scheduleNext();
  }

  function stopTimer(): void {
    pendingToken++; // 使所有挂起回调失效
    if (moodTimer !== undefined) {
      clearTimeout(moodTimer);
      moodTimer = undefined;
    }
  }

  // ---- 身份化行为收集(只读取, 从不写入会话) --------------------------------

  pi.on("input", (event) => {
    const t = (event?.text ?? "").trim();
    if (!t) return;
    if (t.startsWith("/")) pushList(userOps, `命令: ${t}`, OPS_MAX);
    else pushList(userSpeech, `你说: ${t.slice(0, 60)}`, SPEECH_MAX);
    // 用户有小动作 → 吐槽间隔立即重置为 30s
    resetSchedule();
  });

  // 仅更新 Agent 最新回复文本(供吐槽题材用), 不在这里触发吐槽
  pi.on("message_end", (event, ctx) => {
    activeCtx = ctx;
    if (event.message?.role !== "assistant") return;
    const text = textFromContent((event.message as { content?: unknown }).content);
    if (text) agentReply = text.slice(0, AGENT_REPLY_MAX);
  });

  // ---- 手动命令 -----------------------------------------------------------

  pi.registerCommand("mood", {
    description: "情绪管家: /mood 随机吐槽; /mood user|model 指定对象; /mood off|on 开关; /mood memory 查记忆",
    handler: async (args, ctx) => {
      const arg = String(args ?? "").trim().toLowerCase();
      if (arg === "off") {
        enabled = false;
        mood = "";
        renderMood(ctx);
        ctx.ui.notify("情绪管家已关闭(定时吐槽暂停)", "info");
        return;
      }
      if (arg === "on") {
        enabled = true;
        renderMood(ctx);
        ctx.ui.notify("情绪管家已开启", "info");
        return;
      }
      if (arg === "memory") {
        const total = memory.toUser.length + memory.toModel.length;
        if (total === 0) {
          ctx.ui.notify("独立记忆为空, 还没吐槽过。先来一句 /mood 吧。", "info");
          return;
        }
        const items: string[] = [];
        for (let i = memory.toUser.length - 1; i >= 0; i--) items.push(`👤 ${memory.toUser[i]}`);
        for (let i = memory.toModel.length - 1; i >= 0; i--) items.push(`🤖 ${memory.toModel[i]}`);
        await ctx.ui.select(`独立记忆 (共 ${total} 条) 👤对用户 / 🤖对模型`, items);
        return;
      }
      // arg === "user" | "model" | 空 → 立即指定或随机来一句
      let t: "USER" | "MODEL";
      if (arg === "model") t = "MODEL";
      else if (arg === "user") t = "USER";
      else t = Math.random() < 0.5 ? "USER" : "MODEL";
      if (!enabled) enabled = true;
      const prev = mood;
      await runMood(ctx, pi, t);
      renderMood(ctx);
      ctx.ui.notify(mood && mood !== prev ? `[${t}] ${mood}` : "暂时想不到说什么…", "info");
    },
  });

  // ---- 会话生命周期: 开始恢复记忆并启动定时器, 结束清理 --------------------

  pi.on("session_start", async (_event, ctx) => {
    memory = { toUser: [], toModel: [] };
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === MEMORY_KEY) {
        const d = (entry.data as { toUser?: unknown; toModel?: unknown } | undefined) ?? {};
        if (Array.isArray(d.toUser)) memory.toUser = (d.toUser as string[]).slice(-MEMORY_MAX);
        if (Array.isArray(d.toModel)) memory.toModel = (d.toModel as string[]).slice(-MEMORY_MAX);
      }
    }
    activeCtx = ctx;
    ctx.ui.setStatus(STATUS_ID, undefined);
    startTimer();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopTimer();
    ctx.ui.setStatus(STATUS_ID, undefined);
  });
}
