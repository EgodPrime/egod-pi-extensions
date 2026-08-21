/**
 * pi-mood · user-profile 联动模块(文件直读,单向软依赖)
 *
 * 读取 pi-user-profile 持久化的全局画像文件,构造一段"紧凑"的画像上下文,
 * 供情绪管家旁路 LLM 个性化其鼓励句 / 知识点。
 *
 * 设计要点:
 *   - 文件直读 <agentDir>/extensions_data/pi-user-profile/user-profile.json
 *     (路径与 pi-user-profile 完全一致,同受 PI_CODING_AGENT_DIR 覆盖)。
 *   - 降级即默认:文件缺失 / JSON 坏 / enabled !== true / 无有效字段 → available:false,
 *     绝不影响 mood 主流程、绝不抛错。
 *   - 只取对"一行陪伴"最有个性化价值的字段,硬预算 PROFILE_MAX_TOKENS 尾部裁剪。
 *   - 纯函数、零依赖(仅 node 内置 fs/os/path),不 import 任何扩展代码。
 */

import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** 注入 mood prompt 的画像 token 预算(远小于 user-profile 自身的 1024 注入阈值)。 */
const PROFILE_MAX_TOKENS = 320;

// 按个性化价值排序(尾部 key 最先被预算裁剪)。
// 不取 preferences / workStyle(与"一行陪伴"相关性最低)。
const MOOD_KEYS = ["domains", "language", "communication", "values", "avoid"] as const;
type MoodKey = (typeof MOOD_KEYS)[number];

const KEY_LABEL: Record<MoodKey, string> = {
  domains: "领域/技术栈",
  language: "语言",
  communication: "沟通",
  values: "重视",
  avoid: "避免",
};

export interface MoodProfileContext {
  /** 仅当画像 enabled 且含实质字段时为 true。 */
  available: boolean;
  /** 紧凑画像块(多行);不可用时为 ""。 */
  text: string;
  /** 画像块粗估 token 数。 */
  tokens: number;
}

function configDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}
function profilePath(): string {
  return join(configDir(), "extensions_data", "pi-user-profile", "user-profile.json");
}

/** 粗估 tokens:CJK≈0.75 token/字,拉丁≈4 字符/token。与 pi-user-profile 同口径。 */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g) || []).length;
  const latin = text.length - cjk;
  return Math.max(1, Math.ceil(cjk / 1.3 + latin / 4));
}

const UNAVAILABLE: MoodProfileContext = { available: false, text: "", tokens: 0 };

/**
 * 文件直读 user-profile 画像,构造紧凑上下文。
 * 任何失败(文件缺失 / JSON 坏 / 未启用 / 无有效字段)→ 返回 unavailable(降级)。
 */
export async function loadProfileContext(): Promise<MoodProfileContext> {
  let raw: string;
  try {
    raw = await readFile(profilePath(), "utf8");
  } catch {
    return UNAVAILABLE;
  }

  let data: { enabled?: unknown; profile?: Record<string, unknown>; items?: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    return UNAVAILABLE;
  }
  if (!data || data.enabled !== true) return UNAVAILABLE;

  // 主读 profile 视图(pi-user-profile 每次落盘都会由 items 重算,必然同步)。
  const byKey = new Map<string, string[]>();
  if (data.profile && typeof data.profile === "object") {
    for (const k of MOOD_KEYS) {
      const arr = data.profile[k];
      if (Array.isArray(arr)) {
        const texts = arr
          .filter((s): s is string => typeof s === "string" && s.trim() !== "")
          .map((s) => s.trim());
        if (texts.length) byKey.set(k, texts);
      }
    }
  }

  // 防御性回退:profile 视图缺失/全空但 items 非空时,从 items 派生同 key 文本。
  if (![...byKey.values()].some((a) => a.length) && Array.isArray(data.items)) {
    for (const it of data.items as { key?: unknown; text?: unknown }[]) {
      if (
        it &&
        typeof it.key === "string" &&
        (MOOD_KEYS as readonly string[]).includes(it.key) &&
        typeof it.text === "string" &&
        it.text.trim()
      ) {
        const list = byKey.get(it.key) ?? [];
        list.push(it.text.trim());
        byKey.set(it.key, list);
      }
    }
  }

  const lines: string[] = [];
  for (const k of MOOD_KEYS) {
    const arr = byKey.get(k);
    if (arr && arr.length) lines.push(`${KEY_LABEL[k]}: ${arr.join("; ")}`);
  }
  if (!lines.length) return UNAVAILABLE;

  // 预算裁剪:从尾部(最不重要)key 整行丢弃,直到 ≤ 预算。
  let text = lines.join("\n");
  while (estimateTokens(text) > PROFILE_MAX_TOKENS && lines.length > 1) {
    lines.pop();
    text = lines.join("\n");
  }
  return { available: true, text, tokens: estimateTokens(text) };
}
