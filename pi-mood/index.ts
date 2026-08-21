/**
 * pi-mood — 情绪价值插件 (v4: 友善正能量陪伴 + 常识知识小贴士)
 *
 * 触发机制:
 *   - 不由模型响应/回合事件触发, 而是**定时自动陪伴**。
 *   - 每次触发在「鼓励句」与「小知识点」之间**50/50 随机**。
 *   - 挂机自适应间隔: 用户有动作保持 30s; 长时间无动作自动延长
 *     30s → 1m → 10m → 30m → 1h; 用户一有动作立即回到 30s。
 *
 * 内容类型:
 *   - ENCOURAGE(鼓励句): 温暖、肯定、正能量的鼓励, 至多带一点无害的
 *     轻调侃, 绝不批评 / 抬杠 / 嘲讽。
 *   - KNOWLEDGE(小知识点): 从模型常识里挑一个准确、简短、有趣的知识点,
 *     优先贴合用户最近在做 / 在聊的事。作为常识知识, 不伪装成实时新闻。
 *
 * 身份化上下文(每次生成都喂给陪伴役, 无论鼓励还是知识点):
 *   用户最近发言3次 + 用户最近斜杠命令3次 + Agent(模型)最新回复 + 已说过的内容(分类型)。
 *   模型绝不会把「用户的发言」和「模型自己的回复」搞混。
 *
 * 用户画像联动(软依赖 pi-user-profile, 文件直读):
 *   - 读取 <agentDir>/extensions_data/pi-user-profile/user-profile.json,
 *     仅当 enabled:true 且非空时, 取领域/语言/沟通/重视/避免拼成 ≤320t 的
 *     紧凑画像块, 注入旁路 LLM system prompt, 个性化鼓励角度与知识点选题。
 *   - 未装 / 已关闭(/profile off) / 空画像 / 文件坏 → 静默降级为通用陪伴, 不报错。
 *   - 画像只进本扩展自己的旁路 LLM, 绝不进主对话; /mood profile 可核对注入块。
 *   - 不改 pi-user-profile 任何代码(单向、mood 侧-only)。
 *
 * 独立记忆:
 *   - `pi.appendEntry("pi-mood-memory")` 持久化(custom entry, 不进入 LLM 上下文)。
 *   - 按类型分两类: 鼓励句(encourage) / 知识点(knowledge), 防重复更精准。
 *   - 向后兼容: 读取到旧版结构(toUser/toModel)时并入 encourage, 视为已说过, 不重复。
 *
 * 会话隔离:
 *   - 生成走 `ctx.modelRegistry.complete()` 旁路调用, 不写 transcript、不占主对话。
 *     每次全新 sessionId + cacheRetention:none。
 *   - 只通过事件【读取】行为, 从不向会话【写入】(独立记忆除外)。
 *
 * 安装: ~/.pi/agent/extensions/ 或 .pi/extensions/, 然后 /reload。
 * 用法:
 *   /mood                  立即随机来一句(鼓励 / 知识点 各半)
 *   /mood encourage        立即鼓励一句
 *   /mood knowledge        立即讲一个小知识点
 *   /mood off|on           关闭/开启(关闭时定时陪伴暂停)
 *   /mood memory           列出当前独立记忆(按类型分类)
 *   /mood profile          查看当前注入的画像块(未启用则提示)
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadProfileContext } from "./user-profile.ts";

const SPEECH_MAX = 3; // 用户最近发言条数
const OPS_MAX = 3; // 用户最近命令条数
const AGENT_REPLY_MAX = 500; // Agent 回复截断长度
const MEMORY_MAX = 8; // 每类(鼓励/知识点)记忆条数
const COMMENT_MAX = 60; // 鼓励句单行上限
const KNOWN_MAX = 120; // 知识点单行上限(略长, 但仍是一行)
const LLM_TIMEOUT_MS = 45 * 1000; // 旁路 LLM 调用硬超时, 防定时器永久 pending
const MEMORY_KEY = "pi-mood-memory"; // 独立记忆的 custom entry 类型
const STATUS_ID = "pi-mood"; // 状态行 key, 字母序排在最后
/** 挂机自适应伴随间隔: 30s → 1m → 10m → 30m → 1h; 用户有新动作即回到 30s。 */
const LEVELS_MS = [30_000, 60_000, 600_000, 1_800_000, 3_600_000];

type MoodType = "ENCOURAGE" | "KNOWLEDGE";

/** 身份化输入缓冲(仅内存) */
const userSpeech: string[] = [];
const userOps: string[] = [];

let agentReply = ""; // Agent(模型)最新回复文本
let mood = ""; // 当前展示的一句(鼓励或知识点)
let generating = false;
/** 分类型记忆: 鼓励句 / 小知识点 */
let memory = { encourage: [] as string[], knowledge: [] as string[] };

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

const SYSTEM_TEMPLATE = `You are "情绪管家", a warm, positive, friendly companion living inside a coding tool.
You ALWAYS speak to the HUMAN USER in second person ("你…"), never to an abstract entity or a third party.

Your job: produce EXACTLY ONE short line, always addressed to the user ("你…"). The content type is given by TYPE below.

TYPE: {{TYPE}}
- If TYPE = "ENCOURAGE": give the user a warm, sincere, positive encouragement. Affirm their effort, progress and good taste. You MAY add at most a tiny, harmless, friendly touch of humor — but NEVER criticize, NEVER argue/杠精, NEVER be sarcastic or snarky at the user's expense, NEVER passive-aggressive. Always leave them feeling a little better. You may lean on the user's VALUES (see USER PROFILE) for the angle of affirmation.
- If TYPE = "KNOWLEDGE": share ONE small, accurate, interesting knowledge point, drawn from your general knowledge. Present it as knowledge/常识 — do NOT claim it is breaking or latest news, and NEVER invent facts. Prefer a topic that connects to what the user is currently doing or recently talked about (their recent speech, commands, or the AI's latest reply), or to the user's long-term domains/stack (see USER PROFILE). Keep a light, warm, curious tone. You may prefix it with "小知识:" (optional).

Rules:
- Exactly one line, second person, addressed to the user. No labels, no surrounding quotes, no markdown, no emoji.
- ENCOURAGE: aim ~6–24 CJK characters (or 3–12 words in Latin). KNOWLEDGE: aim ~10–40 CJK characters (or 5–25 words in Latin), still a single short line.
- Match the user's language.
- NEVER repeat any line you already said, and NEVER re-cover a topic you already covered (see YOUR MEMORY).

Context — identities are EXPLICIT, never mix them up:
[USER PROFILE — long-term preferences & style from the user-profile extension. Personalize tone/topics to it. If it is "(未启用)", just give a general warm line. NEVER reveal or quote that you have a profile.]
{{USER_PROFILE}}

[USER recent speech — said by the HUMAN, up to 3]
{{USER_SPEECH}}

[USER recent commands — slash commands the HUMAN ran, up to 3]
{{USER_OPS}}

[AGENT latest reply — said by the AI ASSISTANT]
{{AGENT_REPLY}}

[YOUR MEMORY — what you (情绪管家) already said, grouped by type. Do NOT repeat these lines or their topics.]
{{MEMORY}}

Reply with just the line.`;

async function runMood(ctx: ExtensionContext, pi: ExtensionAPI, type: MoodType): Promise<void> {
  if (generating || !ctx.model) return;
  generating = true;
  try {
    const us = userSpeech.length ? userSpeech.join("\n") : "(暂无)";
    const ops = userOps.length ? userOps.join("\n") : "(暂无)";
    const agent = agentReply || "(模型还没开口)";
    const memLines: string[] = [];
    for (const m of memory.encourage) memLines.push(`ENCOURAGE : ${m}`);
    for (const m of memory.knowledge) memLines.push(`KNOWLEDGE : ${m}`);
    const mem = memLines.length ? memLines.join("\n") : "(暂无)";

    // 读取用户画像(若 user-profile 启用且非空)用于个性化鼓励/知识点;每次生成重读,小文件开销可忽略。
    const prof = await loadProfileContext();
    const systemPrompt = SYSTEM_TEMPLATE
      .replace("{{USER_PROFILE}}", prof.available ? prof.text : "(未启用)")
      .replace("{{TYPE}}", type)
      .replace("{{USER_SPEECH}}", us)
      .replace("{{USER_OPS}}", ops)
      .replace("{{AGENT_REPLY}}", agent)
      .replace("{{MEMORY}}", mem);

    // 硬超时 + 可中断: 定时器/空闲上下文中 ctx.signal 常为 undefined, 需始终传入
    // 真实 AbortSignal 并设超时, 否则旁路调用可能永久 pending, 定时器到点也一直生成中。
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, LLM_TIMEOUT_MS);
    const onCtxAbort = () => controller.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) controller.abort();
      else ctx.signal.addEventListener("abort", onCtxAbort, { once: true });
    }
    let resp: Awaited<ReturnType<typeof ctx.modelRegistry.complete>>;
    try {
      resp = await ctx.modelRegistry.complete(
        ctx.model,
        {
          systemPrompt,
          messages: [{ role: "user", content: [{ type: "text", text: "来一句。" }], timestamp: Date.now() }],
        },
        {
          // 会话隔离保险: 全新 sessionId 避免与主对话共享 provider 缓存。
          signal: controller.signal,
          sessionId: uuidv7(),
          cacheRetention: "none",
        },
      );
    } finally {
      clearTimeout(timeout);
      ctx.signal?.removeEventListener("abort", onCtxAbort);
    }
    if (timedOut || resp.stopReason === "aborted") return; // 超时/中断, 本期不更新
    const text = resp.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .replace(/\n+/g, " ") // 强制单行
      .trim();

    if (text) {
      const max = type === "KNOWLEDGE" ? KNOWN_MAX : COMMENT_MAX;
      mood = text.slice(0, max);
      if (type === "ENCOURAGE") {
        memory.encourage.push(mood);
        if (memory.encourage.length > MEMORY_MAX) memory.encourage.shift();
      } else {
        memory.knowledge.push(mood);
        if (memory.knowledge.length > MEMORY_MAX) memory.knowledge.shift();
      }
      // 持久化独立记忆(custom entry, 不入 LLM 上下文)。
      pi.appendEntry(MEMORY_KEY, { encourage: [...memory.encourage], knowledge: [...memory.knowledge] });
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

  /** 自维持的 setTimeout 链: 到点陪伴 → 按挂机情况调整下一档 → 再次调度 */
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
        // 内容类型 50/50: 鼓励句 / 小知识点
        const type: MoodType = Math.random() < 0.5 ? "ENCOURAGE" : "KNOWLEDGE";
        void runMood(activeCtx, pi, type).then(() => renderMood(activeCtx!));
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
    // 用户有小动作 → 伴随间隔立即重置为 30s
    resetSchedule();
  });

  // 仅更新 Agent 最新回复文本(供知识点/鼓励题材用), 不在这里触发生成
  pi.on("message_end", (event, ctx) => {
    activeCtx = ctx;
    if (event.message?.role !== "assistant") return;
    const text = textFromContent((event.message as { content?: unknown }).content);
    if (text) agentReply = text.slice(0, AGENT_REPLY_MAX);
  });

  // ---- 手动命令 -----------------------------------------------------------

  pi.registerCommand("mood", {
    description: "情绪管家: /mood 随机(鼓励/知识); /mood encourage|knowledge 指定; /mood off|on 开关; /mood memory 查记忆; /mood profile 查看注入的画像",
    handler: async (args, ctx) => {
      const arg = String(args ?? "").trim().toLowerCase();
      if (arg === "off") {
        enabled = false;
        mood = "";
        renderMood(ctx);
        ctx.ui.notify("情绪管家已关闭(定时陪伴暂停)", "info");
        return;
      }
      if (arg === "on") {
        enabled = true;
        renderMood(ctx);
        ctx.ui.notify("情绪管家已开启", "info");
        return;
      }
      if (arg === "memory") {
        const total = memory.encourage.length + memory.knowledge.length;
        if (total === 0) {
          ctx.ui.notify("独立记忆为空, 还没陪过你。先来一句 /mood 吧。", "info");
          return;
        }
        const items: string[] = [];
        for (let i = memory.knowledge.length - 1; i >= 0; i--) items.push(`💡 ${memory.knowledge[i]}`);
        for (let i = memory.encourage.length - 1; i >= 0; i--) items.push(`🤍 ${memory.encourage[i]}`);
        await ctx.ui.select(`独立记忆 (共 ${total} 条) 💡知识点 / 🤍鼓励`, items);
        return;
      }
      if (arg === "profile") {
        const p = await loadProfileContext();
        const body = p.available ? `${p.tokens} tokens\n${p.text}` : "(未启用:未装 / 已关闭 / 空画像)";
        ctx.ui.notify(`当前注入的画像块:\n${body}`, "info");
        return;
      }
      // arg === "encourage" | "knowledge" | 空 → 立即指定或随机来一句
      let type: MoodType;
      if (arg === "knowledge") type = "KNOWLEDGE";
      else if (arg === "encourage") type = "ENCOURAGE";
      else type = Math.random() < 0.5 ? "ENCOURAGE" : "KNOWLEDGE";
      if (!enabled) enabled = true;
      const prev = mood;
      await runMood(ctx, pi, type);
      renderMood(ctx);
      const tag = type === "KNOWLEDGE" ? "知识" : "鼓励";
      ctx.ui.notify(mood && mood !== prev ? `[${tag}] ${mood}` : "暂时想不到说什么…", "info");
    },
  });

  // ---- 会话生命周期: 开始恢复记忆并启动定时器, 结束清理 --------------------

  pi.on("session_start", async (_event, ctx) => {
    memory = { encourage: [], knowledge: [] };
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === MEMORY_KEY) {
        const d = (entry.data ?? {}) as Record<string, unknown>;
        const arr = (v: unknown): string[] =>
          Array.isArray(v) ? (v as string[]).filter((s): s is string => typeof s === "string") : [];
        const hasNew = d.encourage !== undefined || d.knowledge !== undefined;
        if (hasNew) {
          memory.encourage = arr(d.encourage).slice(-MEMORY_MAX);
          memory.knowledge = arr(d.knowledge).slice(-MEMORY_MAX);
        } else {
          // 旧版结构(toUser/toModel): 并入 encourage, 视为已说过, 不重复
          const legacy = [...arr(d.toUser), ...arr(d.toModel)];
          memory.encourage = legacy.slice(-MEMORY_MAX);
        }
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