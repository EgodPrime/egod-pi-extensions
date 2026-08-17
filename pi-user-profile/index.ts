/**
 * pi-user-profile — 全局持久化用户画像拓展
 *
 * 能力:
 *   1. 自动总结  —— 随用户使用,通过旁路 LLM 增量总结偏好/办事风格,持久化到全局。
 *   2. /figureme —— 预设问卷生成初始画像。
 *   3. 系统提示词注入 —— 每回合 before_agent_start 把画像追加进系统提示词。
 *   4. 自动 lint —— ①结构校验 ②冲突调和(LLM 为主,规则兜底) ③长度硬校验+压缩。
 *
 * 设计要点:
 *   - 单一全局画像,数据统一归到 ~/.pi/agent/extensions_data/pi-user-profile/(受 PI_CODING_AGENT_DIR 覆盖)。
 *   - 信号缓冲存 ~/.pi/agent/extensions_data/pi-user-profile/profile-signals.json,达标(条数 N 或超时 T)才触发一次 LLM 总结(节流)。
 *   - 所有 LLM 调用走 ctx.modelRegistry.complete 旁路,独立 sessionId,不写主对话。
 *   - items 为权威源(便于 lint 溯源),profile.* 为派生视图(供展示/注入),写时同步。
 *   - lint 冲突解决:LLM 调和为主;不可用/失败走确定性兜底(去重合并 + 新取胜 + 标 pending)。
 *   - 长度硬上限 MAX_PROFILE_TOKENS;超限先复用/生成压缩缓存;仍超则禁用注入并提示。
 *
 * 安装: ~/.pi/agent/extensions/ 或 .pi/extensions/ 后 /reload。
 * 用法:
 *   /figureme            首次问卷初始化(或重跑)
 *   /profile             查看画像
 *   /profile status      开关/缓冲/上次总结/tokens/待处理项
 *   /profile on|off      开启/关闭自动总结与注入
 *   /profile reset       清空画像与缓冲
 *   /profile lint        手动全量 lint(结构+冲突+长度)
 *   /profile compress    手动触发生成压缩摘要缓存
 */

import { homedir } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const SIGNAL_THRESHOLD = 8; // 缓冲条数阈值
const SUMMARIZE_INTERVAL_MS = 30 * 60 * 1000; // 距上次总结超时阈值(30 分钟)
const POLL_MS = 60 * 1000; // 节流轮询间隔
const LLM_TIMEOUT_MS = 45 * 1000; // 旁路 LLM 调用硬超时, 防止 summarize/lint/compress 永久挂起
const SIGNAL_TRIM = 240; // 每条用户发言样本最大字符数
const REPLY_TRIM = 600; // assistant 回复样本最大字符数
const MAX_PROFILE_TOKENS = 700; // 注入上下文硬上限
const ITEM_MAX = 60; // 每类条目上限
const DEDUP_SIM = 0.55; // 实体精简: 同 key 近义合并的 bigram 相似度阈值
const STATUS_ID = "pi-user-profile";

const PROFILE_FILENAME = "user-profile.json";
const SIGNALS_FILENAME = "profile-signals.json";

// 条目所属 key(与 profile.* 视图一一对应)
const KEYS = ["language", "domains", "preferences", "workStyle", "communication", "values", "avoid"] as const;
type ItemKey = (typeof KEYS)[number];

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface ProfileItem {
  id: string;
  key: ItemKey;
  text: string;
  ts: string;
  origin: "auto" | "questionnaire" | "manual";
  conflictPending?: boolean;
}

interface UserProfile {
  version: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLintedAt?: string;
  source: "questionnaire" | "auto";
  items: ProfileItem[];
  profile: Record<ItemKey, string[]>;
  summary: string;
  lint: {
    tokens: number;
    conflictsResolved: number;
    lastIssues: string[];
    compressed?: string;
    compressedHash?: string;
  };
}

interface Signal {
  kind: "speech" | "feedback";
  text: string;
  ts: string;
}

interface SignalsFile {
  signals: Signal[];
  cmdCounts: Record<string, number>;
  lastSummarizedAt?: string;
}

interface LintResult {
  ok: boolean;
  fixed: string[];
  issues: string[];
  conflictsResolved: number;
  usedLLM: boolean;
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// 路径 / IO
// ---------------------------------------------------------------------------

function configDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}
/**
 * 数据统一归到 agentDir 下的 extensions_data/<拓名>/ 规范化目录,
 * 避免直接散落在 agent 根目录;顶层受 PI_CODING_AGENT_DIR 覆盖。
 */
function extensionDataDir(): string {
  return join(configDir(), "extensions_data", "pi-user-profile");
}
function profilePath(): string {
  return join(extensionDataDir(), PROFILE_FILENAME);
}
function signalsPath(): string {
  return join(extensionDataDir(), SIGNALS_FILENAME);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 原子写:先写临时文件再 rename,避免写一半留下损坏文件。 */
async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// 画像读写
// ---------------------------------------------------------------------------

function emptyProfile(): UserProfile {
  const now = new Date().toISOString();
  const profile = {} as Record<ItemKey, string[]>;
  for (const k of KEYS) profile[k] = [];
  return {
    version: 1,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    source: "questionnaire",
    items: [],
    profile,
    summary: "",
    lint: { tokens: 0, conflictsResolved: 0, lastIssues: [] },
  };
}

async function loadProfile(): Promise<UserProfile> {
  const p = await readJson<UserProfile | null>(profilePath(), null);
  if (!p) return emptyProfile();
  // 兼容旧字段缺失
  if (!Array.isArray(p.items)) p.items = [];
  if (!p.profile || typeof p.profile !== "object") p.profile = {} as Record<ItemKey, string[]>;
  for (const k of KEYS) if (!Array.isArray(p.profile[k])) p.profile[k] = [];
  if (!p.lint) p.lint = { tokens: 0, conflictsResolved: 0, lastIssues: [] };
  return p;
}

async function saveProfile(p: UserProfile): Promise<void> {
  p.updatedAt = new Date().toISOString();
  // 由 items 派生 profile.* 视图,保证唯一权威源
  p.profile = deriveViews(p.items);
  await writeJsonAtomic(profilePath(), p);
}

function deriveViews(items: ProfileItem[]): Record<ItemKey, string[]> {
  const out = {} as Record<ItemKey, string[]>;
  for (const k of KEYS) {
    out[k] = items.filter((i) => i.key === k).map((i) => i.text);
  }
  return out;
}

function loadSignals(): Promise<SignalsFile> {
  return readJson<SignalsFile>(signalsPath(), { signals: [], cmdCounts: {} });
}
async function saveSignals(s: SignalsFile): Promise<void> {
  await writeJsonAtomic(signalsPath(), s);
}

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return (content as { type?: string; text?: string }[])
    .filter((c) => c?.type === "text" && typeof c.text === "string" && c.text.length > 0)
    .map((c) => c.text as string)
    .join("\n")
    .trim();
}

/** 粗估 tokens:CJK≈0.75 token/字,拉丁≈4 字符/token。纯本地零成本。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g) || []).length;
  const latin = text.length - cjk;
  return Math.max(1, Math.ceil(cjk / 1.3 + latin / 4));
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .trim();
}

/** 简单 bigram Jaccard 相似度(0~1)。 */
function similarity(a: string, b: string): number {
  const bigrams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 && B.size === 0) return a === b ? 1 : 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.max(1, A.size + B.size - inter);
}

/** 简单矛盾启发:一方含否定词/对立短语,另一方与之相对。 */
const ANTONYM_PAIRS: [string, string][] = [
  ["要", "不要"], ["喜欢", "不喜欢"], ["喜欢", "讨厌"], ["prefer", "avoid"],
  ["详细", "简洁"], ["详细", "简短"], ["verbose", "concise"], ["详细", "简单"],
  ["快", "稳"], ["快", "保守"], ["简洁", "啰嗦"],
];
function isContradiction(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  for (const [x, y] of ANTONYM_PAIRS) {
    const xa = na.includes(x.toLowerCase());
    const xb = nb.includes(x.toLowerCase());
    const ya = na.includes(y.toLowerCase());
    const yb = nb.includes(y.toLowerCase());
    if ((xa && yb) || (ya && xb)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 画像描述 → 注入文本
// ---------------------------------------------------------------------------

const KEY_LABEL: Record<ItemKey, string> = {
  language: "常用语言",
  domains: "领域/技术栈",
  preferences: "偏好",
  workStyle: "办事风格",
  communication: "沟通",
  values: "重视",
  avoid: "避免",
};

function itemsToText(items: ProfileItem[], includeSummary = true, limit?: number): string {
  const lines: string[] = [];
  if (includeSummary) {
    lines.push("## 用户画像(User Profile)");
  }
  for (const k of KEYS) {
    const arr = items.filter((i) => i.key === k).map((i) => i.text);
    if (!arr.length) continue;
    const shown = limit ? arr.slice(0, limit) : arr;
    lines.push(`- ${KEY_LABEL[k]}: ${shown.join("; ")}`);
  }
  return lines.join("\n");
}

function buildInjection(p: UserProfile): string {
  const parts: string[] = [];
  parts.push("## 用户画像(User Profile)");
  if (p.summary) parts.push(p.summary);
  const body = itemsToText(p.items, false);
  if (body) parts.push(body);
  // 注入时给 agent 的定位说明
  parts.push(
    "（以上为该用户的长期偏好与办事风格画像,由本机持久化。若与用户当前明确指示冲突,以用户当前指示为准。）",
  );
  return parts.join("\n\n");
}

/** 由 items 生成一个稳定的校验哈希,用于判断压缩缓存是否过期。 */
function itemsHash(items: ProfileItem[]): string {
  return items
    .map((i) => `${i.key}:${normalize(i.text)}`)
    .sort()
    .join("|");
}

/**
 * 实体精简(确定性): ①同 key 较高阈值近义去重 ②仍超预算时逐 key 优先删
 * 「与同 key 其它条目平均相似度最高(最冗余)」的条目, 每个非空 key 至少保留 1 条,
 * 直到注入文本压到预算内。不依赖 LLM, 保证收敛。返回移除条数。
 */
function slimProfile(p: UserProfile, budgetTokens: number): number {
  const start = p.items.length;

  // ① 同 key 近义去重(保留较新)
  const byKey = new Map<ItemKey, ProfileItem[]>();
  for (const k of KEYS) byKey.set(k, []);
  for (const i of p.items) byKey.get(i.key)!.push(i);
  const keptItems: ProfileItem[] = [];
  for (const k of KEYS) {
    const sorted = [...byKey.get(k)!].sort((a, b) => (a.ts < b.ts ? -1 : 1)); // 旧的在前
    const kept: ProfileItem[] = [];
    for (const it of sorted) {
      const a = normalize(it.text);
      const dup = kept.some((x) => {
        const b = normalize(x.text);
        return !!a && !!b && similarity(a, b) > DEDUP_SIM;
      });
      if (!dup) kept.push(it);
    }
    keptItems.push(...kept);
  }
  p.items = keptItems;

  // ② 预算裁剪: 逐 key 优先删除「同 key 平均相似度最高(最冗余)」条目, 每个非空 key 至少保留 1 条
  let tokens = estimateTokens(buildInjection(p));
  while (tokens > budgetTokens) {
    let bestKey: ItemKey | undefined;
    let bestId: string | undefined;
    let bestScore = -1;
    for (const k of KEYS) {
      const list = p.items.filter((i) => i.key === k);
      if (list.length <= 1) continue; // 每个 key 至少保留 1 条
      for (const it of list) {
        const others = list.filter((x) => x.id !== it.id);
        const a = normalize(it.text);
        let s = 0;
        for (const o of others) {
          const b = normalize(o.text);
          if (a && b) s += similarity(a, b);
        }
        s /= Math.max(1, others.length);
        if (s > bestScore) {
          bestScore = s;
          bestKey = k;
          bestId = it.id;
        }
      }
    }
    if (!bestId) break; // 每个非空 key 都只剩 1 条, 无法再删
    p.items = p.items.filter((i) => i.id !== bestId);
    tokens = estimateTokens(buildInjection(p));
  }
  return start - p.items.length;
}

/** 实际注入内容与大小: 未超限用原始, 超限且有有效压缩缓存则用压缩版。 */
function effectiveInjection(p: UserProfile): { text: string; tokens: number } {
  const full = buildInjection(p);
  const fullTokens = estimateTokens(full);
  if (fullTokens <= MAX_PROFILE_TOKENS) return { text: full, tokens: fullTokens };
  if (p.lint.compressed && p.lint.compressedHash === itemsHash(p.items)) {
    return { text: p.lint.compressed, tokens: estimateTokens(p.lint.compressed) };
  }
  return { text: full, tokens: fullTokens };
}

// ---------------------------------------------------------------------------
// 索引/镜像环状缓冲(仅内存,会话内) —— 反馈对信号
// ---------------------------------------------------------------------------

let lastAssistantReply = ""; // 上一条 assistant 回复摘要
let summarizing = false;
let linting = false;

// ---------------------------------------------------------------------------
// LLM 旁路调用
// ---------------------------------------------------------------------------

async function pickModel(ctx: ExtensionContext) {
  if (ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model)) return ctx.model;
  for (const m of ctx.modelRegistry.getAvailable()) {
    if (ctx.modelRegistry.hasConfiguredAuth(m)) return m;
  }
  return undefined;
}

interface LLMResult {
  ok: boolean;
  text: string;
  reason?: string;
}

async function llmCall(
  ctx: ExtensionContext,
  systemPrompt: string,
  userText: string,
): Promise<LLMResult> {
  const model = await pickModel(ctx);
  if (!model) return { ok: false, text: "", reason: "no-model" };

  // 硬超时 + 可中断: 空闲/命令上下文中 ctx.signal 常为 undefined, 此前传给
  // complete 可能导致旁路调用永久挂起, 使 summarizing/linting 标志卡住、
  // 状态栏永远"同步中"。这里始终传入真实 AbortSignal 并设超时, 保证必然结束。
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
  try {
    const resp = await ctx.modelRegistry.complete(
      model,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userText }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        signal: controller.signal,
        sessionId: `${Date.now()}-up-${Math.random().toString(36).slice(2, 8)}`,
        cacheRetention: "none",
      },
    );
    if (timedOut || (resp as { stopReason?: string }).stopReason === "aborted") {
      return { ok: false, text: "", reason: "timeout" };
    }
    const text = textFromContent((resp as { content?: unknown }).content);
    return { ok: true, text };
  } catch (e) {
    return {
      ok: false,
      text: "",
      reason: timedOut ? "timeout" : e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timeout);
    ctx.signal?.removeEventListener("abort", onCtxAbort);
  }
}

/** 从 LLM 输出中尽力提取 JSON 对象。 */
function extractJson<T>(text: string): T | undefined {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // 尝试找第一个 { 到最后一个 }
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 增量总结(节流)
// ---------------------------------------------------------------------------

interface Delta {
  add?: { key: string; text: string }[];
  remove_ids?: string[];
  update?: { id: string; text: string }[];
  summary?: string;
}

const SUMMARIZE_SYSTEM = `你是一个用户画像维护助手。根据「现有画像」与「本轮新增证据」,输出对用户长期偏好/办事风格的增量更新。
要求:
- 只输出一个 JSON 对象,不要任何解释、前后缀、markdown 代码块。
- 结构: {"add": [{"key": "...", "text": "..."}], "remove_ids": [...], "update": [{"id":"...","text":"..."}], "summary": "一句话总述"}
- key 只能取: language | domains | preferences | workStyle | communication | values | avoid
- add 的 text 是简洁的中文/英文短语(与该用户语言一致),去掉空泛词。
- 只依据明确证据;不确定就不加。禁止编造。
- summary 是对全画像的总述,若无需更新可传现有 summary。`;

function summarizeSignalText(signals: Signal[], cmdCounts: Record<string, number>): string {
  const speech = signals
    .filter((s) => s.kind === "speech")
    .map((s) => `[speech] ${s.text}`)
    .join("\n");
  const feedback = signals
    .filter((s) => s.kind === "feedback")
    .map((s) => `[feedback] ${s.text}`)
    .join("\n");
  const cmds = Object.entries(cmdCounts)
    .map(([k, v]) => `/${k} ×${v}`)
    .join(", ");
  return [
    "=== 本轮新增证据 ===",
    speech || "(无发言)",
    "--- AI 回答反馈 ---",
    feedback || "(无)",
    "--- 常用命令 ---",
    cmds || "(无)",
  ].join("\n");
}

async function runSummarize(ctx: ExtensionContext, signalsFile: SignalsFile): Promise<boolean> {
  if (summarizing) return false;
  if (signalsFile.signals.length === 0) return false;
  summarizing = true;
  try {
    const p = await loadProfile();
    const existing = itemsToText(p.items, false);
    const prompt =
      `=== 现有画像 ===\n${existing || "(空)"}\n\n${summarizeSignalText(signalsFile.signals, signalsFile.cmdCounts)}\n` +
      `\n=== 现有 summary ===\n${p.summary || "(空)"}\n\n` +
      `根据以上输出增量 JSON。`;
    const r = await llmCall(ctx, SUMMARIZE_SYSTEM, prompt);
    if (!r.ok || !r.text) return false;

    const delta = extractJson<Delta>(r.text);
    if (!delta) return false;

    let changed = false;
    if (Array.isArray(delta.remove_ids)) {
      const rm = new Set(delta.remove_ids);
      const before = p.items.length;
      p.items = p.items.filter((i) => !rm.has(i.id));
      if (p.items.length !== before) changed = true;
    }
    if (Array.isArray(delta.update)) {
      for (const u of delta.update) {
        if (!u.id || typeof u.text !== "string") continue;
        const it = p.items.find((i) => i.id === u.id);
        if (it && it.text !== u.text) {
          it.text = u.text.slice(0, 200);
          changed = true;
        }
      }
    }
    if (Array.isArray(delta.add)) {
      for (const a of delta.add) {
        if (!a || !KEYS.includes(a.key as ItemKey)) continue;
        const text = (a.text ?? "").trim();
        if (!text || text.length < 2) continue;
        p.items.push({
          id: newId(),
          key: a.key as ItemKey,
          text: text.slice(0, 200),
          ts: new Date().toISOString(),
          origin: "auto",
        });
        changed = true;
      }
    }
    if (typeof delta.summary === "string" && delta.summary.trim()) {
      p.summary = delta.summary.trim().slice(0, 400);
      changed = true;
    }
    // 每类条数上限
    for (const k of KEYS) {
      const list = p.items.filter((i) => i.key === k);
      if (list.length > ITEM_MAX) {
        const ids = new Set(list.slice(0, list.length - ITEM_MAX).map((i) => i.id));
        p.items = p.items.filter((i) => !ids.has(i.id));
        changed = true;
      }
    }

    if (!changed) return false;
    p.source = "auto";
    await saveProfile(p);
    signalsFile.signals = [];
    signalsFile.cmdCounts = {};
    signalsFile.lastSummarizedAt = new Date().toISOString();
    await saveSignals(signalsFile);
    // 画像变更 → 自动 lint
    void runLint(ctx, { auto: true });
    return true;
  } catch {
    return false;
  } finally {
    summarizing = false;
  }
}

// ---------------------------------------------------------------------------
// 冲突调和建议(引导 LLM 输出一致化条目)
// ---------------------------------------------------------------------------

const RECONCILE_PROMPT = (conflictsText: string): string =>
  `以下是一些可能存在矛盾或重复的用户偏好条目(每组来自同一类别)。请把它们调和为“一致、去重、无矛盾”的条目列表。
规则:
- 合并同义/重复条目;矛盾条目保留较可信/较通用的一方,必要时合并成一句平衡表述。
- 不要擅自删除有明确证据的信息;尽量保留信息量。
- 只输出 JSON 数组,形如: ["条目1", "条目2", ...]。不要任何前后缀或 code block。`;

/** 检测并返回需调和的分组(每组同 key 的相似/矛盾条目)。 */
function conflictGroups(items: ProfileItem[]): ProfileItem[][] {
  const byKey = new Map<ItemKey, ProfileItem[]>();
  for (const k of KEYS) byKey.set(k, []);
  for (const i of items) byKey.get(i.key)!.push(i);

  const groups: ProfileItem[][] = [];
  for (const k of KEYS) {
    const list = byKey.get(k)!;
    const placed = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      if (placed.has(i)) continue;
      const cluster: ProfileItem[] = [list[i]];
      for (let j = i + 1; j < list.length; j++) {
        if (placed.has(j)) continue;
        const a = normalize(list[i].text);
        const b = normalize(list[j].text);
        if ((a && b && (similarity(a, b) > 0.85 || isContradiction(list[i].text, list[j].text))) || a === b) {
          cluster.push(list[j]);
          placed.add(j);
        }
        if (cluster.length >= 4) break;
      }
      if (cluster.length > 1) {
        groups.push(cluster);
        for (const c of cluster) placed.add(list.indexOf(c));
      }
    }
  }
  return groups;
}

/** 确定性兜底:合并重复取最新,矛盾取最新并标 pending。 */
function resolveGroupsDeterministic(groups: ProfileItem[][]): { fixed: string[]; removed: Set<string> } {
  const removed = new Set<string>();
  const fixed: string[] = [];
  for (const group of groups) {
    const sorted = [...group].sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const keep = sorted[sorted.length - 1];
    const conflicted = sorted.some((x) => x !== keep && isContradiction(keep.text, x.text));
    for (const x of group) if (x.id !== keep.id) removed.add(x.id);
    if (conflicted) keep.conflictPending = true;
    fixed.push(`调和「${group[0].key}」${group.length} 条 → "${keep.text}"`);
  }
  return { fixed, removed };
}

async function runConflictLint(ctx: ExtensionContext, p: UserProfile): Promise<LintResult> {
  const groups = conflictGroups(p.items);
  const result: LintResult = {
    ok: true,
    fixed: [],
    issues: [],
    conflictsResolved: 0,
    usedLLM: false,
  };
  if (groups.length === 0) return result;
  result.conflictsResolved = groups.length;

  // 尝试 LLM 调和
  const conflictsText = groups
    .map((g) => g.map((i) => `- ${i.text}`).join("\n    "))
    .join("\n\n");
  const rr = await llmCall(ctx, RECONCILE_PROMPT(conflictsText), `调和以下分组的冲突条目:\n\n${conflictsText}\n\n输出每组合并后的条目 JSON 数组。`);
  if (rr.ok && rr.text) {
    const arr = extractJson<string[]>(rr.text);
    if (Array.isArray(arr) && arr.length) {
      result.usedLLM = true;
      // 用调和结果替换每个冲突组(按组顺序取前 N 条)
      let zi = 0;
      const removed = new Set<string>();
      const additions: ProfileItem[] = [];
      for (const g of groups) {
        for (const x of g) removed.add(x.id);
      }
      p.items = p.items.filter((i) => !removed.has(i.id));
      for (const g of groups) {
        const key = g[0].key;
        const take = Math.min(2, arr.length - zi);
        for (let n = 0; n < take; n++) {
          const t = (arr[zi + n] ?? "").trim();
          if (!t) continue;
          additions.push({
            id: newId(),
            key,
            text: t.slice(0, 200),
            ts: new Date().toISOString(),
            origin: "auto",
          });
        }
        zi += take;
      }
      p.items.push(...additions);
      result.fixed.push(`LLM 调和 ${groups.length} 组冲突`);
      return result;
    }
  }
  // 兜底
  const det = resolveGroupsDeterministic(groups);
  p.items = p.items.filter((i) => !det.removed.has(i.id));
  result.fixed.push(...det.fixed);
  return result;
}

// ---------------------------------------------------------------------------
// lint 主流程
// ---------------------------------------------------------------------------

async function runLint(ctx: ExtensionContext, opts: { auto?: boolean } = {}): Promise<LintResult> {
  if (linting) return { ok: true, fixed: ["(之前一次 lint 仍在运行,已跳过)"], issues: [], conflictsResolved: 0, usedLLM: false };
  linting = true;
  try {
    const p = await loadProfile();
    const fixed: string[] = [];
    const issues: string[] = [];

    // ① 结构校验(零成本,自动修复)
    if (!Array.isArray(p.items)) {
      p.items = [];
      fixed.push("items 非数组,已重置为空");
    }
    p.items = p.items.filter((i) => {
      const valid =
        i && typeof i === "object" && KEYS.includes(i.key) &&
        typeof i.text === "string" && i.text.trim().length > 0;
      if (!valid) issues.push("移除一条无效条目");
      return !!valid;
    });
    const seen = new Set<string>();
    p.items = p.items.filter((i) => {
      if (seen.has(i.id)) {
        issues.push(`重复 id:${i.id} 已移除`);
        return false;
      }
      seen.add(i.id);
      return true;
    });
    if (typeof p.summary !== "string") {
      p.summary = "";
      fixed.push("summary 非字符串,已重置");
    }

    // ② 冲突调和
    const conflict = await runConflictLint(ctx, p);
    fixed.push(...conflict.fixed);
    issues.push(...conflict.issues);
    p.lint.conflictsResolved += conflict.conflictsResolved;

    // ③ 实体精简: 同 key 放宽阈值近义合并 + token 预算裁剪, 真正把画像本体压到限内
    const slimmed = slimProfile(p, MAX_PROFILE_TOKENS);
    if (slimmed > 0) fixed.push(`实体精简: 移除/合并 ${slimmed} 条多余条目`);

    // ④ 长度:估算注入文本大小(精简后)
    const injection = buildInjection(p);
    const tokens = estimateTokens(injection);
    p.lint.tokens = tokens;
    if (tokens > MAX_PROFILE_TOKENS) {
      issues.push(`注入上下文约 ${tokens} tokens,超过上限 ${MAX_PROFILE_TOKENS},需压缩`);
    }

    // 清理结构 lint 里可能产生的过期压缩缓存(如条目已变)
    const h = itemsHash(p.items);
    if (p.lint.compressedHash && p.lint.compressedHash !== h) {
      p.lint.compressed = undefined;
      p.lint.compressedHash = undefined;
      fixed.push("清理过期压缩缓存");
    }

    p.lint.lastIssues = issues;
    p.lastLintedAt = new Date().toISOString();
    await saveProfile(p);

    // ⑤ lint 时自动压缩: 实体精简后仍未到限内, 则刷新压缩缓存供注入使用
    if (tokens > MAX_PROFILE_TOKENS) {
      const c = await compressProfile(ctx, p);
      if (c) fixed.push("已自动刷新压缩缓存");
    }

    return { ok: conflict.ok && issues.length === 0, fixed, issues, conflictsResolved: conflict.conflictsResolved, usedLLM: conflict.usedLLM };
  } finally {
    linting = false;
  }
}

// ---------------------------------------------------------------------------
// 压缩(生成注入用压缩摘要缓存)
// ---------------------------------------------------------------------------

const COMPRESS_SYSTEM = `你是用户画像压缩助手。把「完整画像」压缩为一段不长于约 500 tokens 的画像描述,同时尽量保留关键偏好/风格/沟通要点。
- 输出纯文本(可含简短 bullet),不要 markdown 标题,不要前后缀,不要 JSON。`;

async function compressProfile(ctx: ExtensionContext, p: UserProfile): Promise<string | undefined> {
  const full = buildInjection(p);
  if (estimateTokens(full) <= MAX_PROFILE_TOKENS) {
    p.lint.compressed = undefined;
    p.lint.compressedHash = undefined;
    await saveProfile(p);
    return undefined;
  }
  // 复用有效压缩缓存, 避免每次强制发起 LLM 调用 —— 这正是 compress 卡死的根源之一。
  const h = itemsHash(p.items);
  if (p.lint.compressed && p.lint.compressedHash === h) return p.lint.compressed;
  const r = await llmCall(ctx, COMPRESS_SYSTEM, full.slice(0, 8000));
  if (!r.ok || !r.text) return undefined;
  const compressed = `## 用户画像(User Profile)(压缩)\n\n${r.text.trim().slice(0, 2000)}`;
  if (estimateTokens(compressed) > MAX_PROFILE_TOKENS) return undefined;
  p.lint.compressed = compressed;
  p.lint.compressedHash = itemsHash(p.items);
  await saveProfile(p);
  return compressed;
}

/** 注入前长度硬校验:返回可直接注入的文本,超限且无法压缩则返回 null(禁用注入)。 */
async function ensureInjectionReady(ctx: ExtensionContext, p: UserProfile): Promise<string | null> {
  const full = buildInjection(p);
  if (estimateTokens(full) <= MAX_PROFILE_TOKENS) return full;
  // 复用有效压缩缓存
  const h = itemsHash(p.items);
  if (p.lint.compressed && p.lint.compressedHash === h) return p.lint.compressed;
  // 未缓存 → 异步生成压缩,本次禁用注入,避免阻塞回合
  void compressProfile(ctx, p);
  return null;
}

// ---------------------------------------------------------------------------
// 状态行
// ---------------------------------------------------------------------------

function renderStatus(ctx: ExtensionContext, p: UserProfile | undefined): void {
  if (!p || !p.enabled) {
    ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", "⏸ 画像(off)"));
    return;
  }
  if (summarizing || linting) {
    ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", "◈ 画像…同步中"));
    return;
  }
  const eff = effectiveInjection(p);
  const over = eff.tokens > MAX_PROFILE_TOKENS;
  ctx.ui.setStatus(
    STATUS_ID,
    ctx.ui.theme.fg(
      over ? "warning" : "success",
      `${over ? "⚠" : "⏺"} 画像(${p.items.length}条/${eff.tokens}t)`,
    ),
  );
}

// ---------------------------------------------------------------------------
// 问卷
// ---------------------------------------------------------------------------

interface Question {
  id: ItemKey;
  label: string;
  prompt: string;
  options: string[];
}

const FIGUREME_QUESTIONS: Question[] = [
  {
    id: "language",
    label: "语言",
    prompt: "你希望 agent 主要用哪种语言与你交流?",
    options: ["中文", "English", "中英混合"],
  },
  {
    id: "domains",
    label: "领域/栈",
    prompt: "你最常的工作领域或技术栈是?",
    options: ["Web 全栈", "后端/服务", "前端", "数据/ML", "脚本/运维", "通用(什么都有)"],
  },
  {
    id: "workStyle",
    label: "办事风格",
    prompt: "你希望 agent 通常怎么推进任务?",
    options: ["先给计划再动手", "边做边交,快速迭代", "直接做出结果", "严谨保守,少冒险"],
  },
  {
    id: "communication",
    label: "沟通偏好",
    prompt: "你偏好 agent 的回答风格?",
    options: ["简洁直接", "详细解释原理", "多给示例/代码", "多用列表分步骤"],
  },
  {
    id: "preferences",
    label: "回答偏好",
    prompt: "需要改代码时,你更希望 agent 怎么做?",
    options: ["代码优先,直接给可用的", "先解释思路再改", "给多种方案供选择", "直接帮我改文件"],
  },
  {
    id: "values",
    label: "重视",
    prompt: "你最看重什么?",
    options: ["正确性", "速度", "可维护性/可读性", "安全性", "兼容性"],
  },
  {
    id: "avoid",
    label: "避免",
    prompt: "你最不希望 agent 做什么?",
    options: ["啰嗦/过度解释", "不经确认就删除/覆盖", "过度自信/编造", "不解释就开干"],
  },
];

/** 顺序对话框驱动的问卷(可选 + 自定义),结果直接写入画像 items。 */
async function runFigureme(ctx: ExtensionCommandContext): Promise<boolean> {
  if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
    ctx.ui.notify("在当前运行模式无法弹出问卷。请在交互模式下运行 /figureme。", "warning");
    return false;
  }
  const p = await loadProfile();
  const now = new Date().toISOString();
  let cancelled = false;
  let wrote = false;

  p.items = p.items.filter((i) => i.origin !== "questionnaire"); // 重跑时清掉旧问卷条目

  for (const q of FIGUREME_QUESTIONS) {
    const allOptions = [...q.options, "✎ 自定义输入…"];
    const picked = await ctx.ui.select(`${q.prompt} (${q.label}, Enter 选择 · Esc 跳过)`, allOptions);
    if (picked === undefined) {
      // Esc 取消整个问卷
      cancelled = true;
      break;
    }
    let text = picked;
    if (text === "✎ 自定义输入…") {
      const custom = await ctx.ui.input("请输入你的回答:", q.options[0]);
      if (custom === undefined) {
        cancelled = true;
        break;
      }
      text = custom.trim() || q.options[0];
    } else {
      text = picked.replace(/^\d+\.\s*/, "").trim();
    }
    if (text) {
      p.items.push({ id: newId(), key: q.id, text: text.slice(0, 200), ts: now, origin: "questionnaire" });
      wrote = true;
    }
  }

  if (cancelled || !wrote) return false;

  // summary 由答案确定性生成
  const parts = FIGUREME_QUESTIONS.map((q) => {
    const item = p.items.find((i) => i.key === q.id);
    return item ? `${KEY_LABEL[q.id]}${item.text}` : "";
  }).filter(Boolean);
  p.summary = `用户偏好 ${parts.join("; ")}。`;
  p.source = "questionnaire";
  await saveProfile(p);
  // 立即 lint 一次
  await runLint(ctx);
  return true;
}

// ---------------------------------------------------------------------------
// 命令 handler
// ---------------------------------------------------------------------------

async function handleProfileCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const arg = " " + String(args ?? "").trim().toLowerCase() + " ";

  const p = await loadProfile();

  if (arg.includes(" off")) {
    p.enabled = false;
    await saveProfile(p);
    renderStatus(ctx, p);
    ctx.ui.notify("用户画像已关闭(不再自动总结与注入)。", "info");
    return;
  }
  if (arg.includes(" on")) {
    p.enabled = true;
    await saveProfile(p);
    renderStatus(ctx, p);
    ctx.ui.notify("用户画像已开启。", "info");
    return;
  }
  if (arg.includes(" reset")) {
    const ok = ctx.hasUI
      ? await ctx.ui.confirm("确认清空用户画像与缓冲?", "此操作不可撤销。")
      : true;
    if (!ok) {
      ctx.ui.notify("已取消。", "info");
      return;
    }
    await writeJsonAtomic(profilePath(), emptyProfile());
    await writeJsonAtomic(signalsPath(), { signals: [], cmdCounts: {} });
    renderStatus(ctx, await loadProfile());
    ctx.ui.notify("用户画像与缓冲已清空。", "info");
    return;
  }
  if (arg.includes(" lint")) {
    ctx.ui.notify("正在 lint…", "info");
    const r = await runLint(ctx);
    if (r.usedLLM) ctx.ui.notify(`lint 完成:调和 ${r.conflictsResolved} 组冲突(LLM)` + (r.issues.length ? `,${r.issues.length} 项待处理` : ""), "info");
    else ctx.ui.notify(`lint 完成:修复 ${r.fixed.length} 项` + (r.issues.length ? `,${r.issues.length} 项待处理` : ""), r.ok ? "info" : "warning");
    return;
  }
  if (arg.includes(" compress")) {
    const h = itemsHash(p.items);
    if (p.lint.compressed && p.lint.compressedHash === h) {
      ctx.ui.notify("压缩缓存已存在且有效, 直接复用, 无需重新生成。", "info");
      return;
    }
    ctx.ui.notify("正在压缩…", "info");
    const c = await compressProfile(ctx, p);
    ctx.ui.notify(c ? "已生成压缩摘要缓存。" : "当前画像未超限或压缩失败。", c ? "info" : "warning");
    return;
  }
  if (arg.includes(" status")) {
    const signals = await loadSignals();
    const issues = (p.lint.lastIssues || []).length;
    const eff = effectiveInjection(p);
    const mode = eff.text !== buildInjection(p) ? "(压缩)" : "";
    ctx.ui.notify(
      `画像: ${p.enabled ? "开启" : "关闭"} · 条目 ${p.items.length} 条 · 注入约 ${eff.tokens} tokens${mode}` +
        ` · 缓冲 ${signals.signals.length}/${SIGNAL_THRESHOLD} · 上次总结 ${signals.lastSummarizedAt ? signals.lastSummarizedAt.slice(0, 19).replace("T", " ") : "从未"}` +
        ` · 待处理 ${issues}`,
      "info",
    );
    return;
  }
  if (arg.includes(" edit ")) {
    // /profile edit <key> <text>
    const m = String(args).match(/^edit\s+(\w+)\s+(.+)$/s);
    if (!m) {
      ctx.ui.notify("用法: /profile edit <key> <text> (key ∈ language|domains|preferences|workStyle|communication|values|avoid)", "warning");
      return;
    }
    const key = m[1] as ItemKey;
    if (!KEYS.includes(key)) {
      ctx.ui.notify(`无效字段:${m[1]}`, "warning");
      return;
    }
    p.items.push({ id: newId(), key, text: m[2].trim().slice(0, 200), ts: new Date().toISOString(), origin: "manual" });
    await saveProfile(p);
    ctx.ui.notify(`已添加 ${KEY_LABEL[key]}: ${m[2].trim().slice(0, 60)}`, "info");
    return;
  }

  // 默认查看
  if (p.items.length === 0 && !p.summary) {
    ctx.ui.notify("当前还没有画像。运行 /figureme 填问卷,或直接用 /profile edit 添加。", "info");
    return;
  }
  const eff = effectiveInjection(p);
  const lines = [
    `画像(${p.items.length} 条,注入约 ${eff.tokens} tokens,${p.enabled ? "开" : "关"})`,
    `摘要: ${p.summary || "(无)"}`,
    "",
    ...itemsToText(p.items, false).split("\n"),
  ];
  if (ctx.mode === "tui" || ctx.mode === "rpc") {
    await ctx.ui.select("用户画像", lines, {});
  } else {
    ctx.ui.notify(lines.join("\n"), "info");
  }
}

// ---------------------------------------------------------------------------
// 拓展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let throttleTimer: ReturnType<typeof setInterval> | undefined;
  let lastFlushed = new Date(0);

  function stopTimer(): void {
    if (throttleTimer !== undefined) {
      clearInterval(throttleTimer);
      throttleTimer = undefined;
    }
  }

  function startTimer(ctx: ExtensionContext): void {
    stopTimer();
    throttleTimer = setInterval(() => {
      void (async () => {
        const signals = await loadSignals();
        if (signals.signals.length === 0) return;
        const last = signals.lastSummarizedAt ? new Date(signals.lastSummarizedAt).getTime() : 0;
        const enough = signals.signals.length >= SIGNAL_THRESHOLD;
        const timed = Date.now() - last >= SUMMARIZE_INTERVAL_MS;
        if (enough || timed) {
          await runSummarize(ctx, signals);
          renderStatus(ctx, await loadProfile());
        }
      })();
    }, POLL_MS);
  }

  // ---- 信号收集:用户发言 + AI 反馈 ----
  pi.on("input", async (event, ctx) => {
    const t = (event?.text ?? "").trim();
    if (!t) return;
    const signals = await loadSignals();
    if (t.startsWith("/")) {
      const name = t.split(/\s/)[0].slice(1);
      signals.cmdCounts[name] = (signals.cmdCounts[name] ?? 0) + 1;
    } else {
      signals.signals.push({
        kind: "speech",
        text: t.slice(0, SIGNAL_TRIM),
        ts: new Date().toISOString(),
      });
    }
    // 发言后,把上一条 assistant 回复作为反馈对附加(若有)
    if (lastAssistantReply && !t.startsWith("/")) {
      signals.signals.push({
        kind: "feedback",
        text: `AI 说:"${lastAssistantReply.slice(0, 80)}…" 之后用户:${t.slice(0, 160)}`,
        ts: new Date().toISOString(),
      });
      lastAssistantReply = "";
    }
    if (signals.signals.length > SIGNAL_THRESHOLD * 4) {
      signals.signals = signals.signals.slice(-SIGNAL_THRESHOLD * 4);
    }
    await saveSignals(signals);
    void ctx; // ctx 保留给 future 使用
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message?.role !== "assistant") return;
    const text = textFromContent((event.message as { content?: unknown }).content);
    if (text) lastAssistantReply = text.slice(0, REPLY_TRIM);
    void ctx;
  });

  // ---- 会话生命周期 ----
  pi.on("session_start", async (_event, ctx) => {
    const p = await loadProfile();
    lastAssistantReply = "";
    renderStatus(ctx, p);
    startTimer(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopTimer();
    // 强制 flush 剩余缓冲,避免丢数据
    const signals = await loadSignals();
    if (signals.signals.length > 0) {
      await runSummarize(ctx, signals);
    }
    ctx.ui.setStatus(STATUS_ID, undefined);
  });

  // ---- 系统提示词注入 ----
  pi.on("before_agent_start", async (event, ctx) => {
    const p = await loadProfile();
    if (!p.enabled) return;
    if (p.items.length === 0 && !p.summary) return;
    const injection = await ensureInjectionReady(ctx, p);
    if (!injection) {
      renderStatus(ctx, p);
      ctx.ui.notify(`画像上下文超限(约 ${p.lint.tokens} tokens),本回合未注入;正在压缩。`, "warning");
      return;
    }
    return { systemPrompt: event.systemPrompt + "\n\n" + injection };
  });

  // ---- 命令 ----
  pi.registerCommand("figureme", {
    description: "按预设问卷生成/重写用户画像(/figureme)。",
    handler: async (_args, ctx) => {
      const ok = await runFigureme(ctx);
      if (ok) {
        const p = await loadProfile();
        renderStatus(ctx, p);
        ctx.ui.notify("画像已生成(/figureme)。可用 /profile 查看, /profile lint 复查。", "info");
      } else {
        ctx.ui.notify("问卷未完成或已取消,画像未变更。", "info");
      }
    },
  });

  pi.registerCommand("profile", {
    description:
      "用户画像: /profile 查看 · status · on|off · reset · lint · compress · edit <key> <text>",
    handler: handleProfileCommand,
  });
}
