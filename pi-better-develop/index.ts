/**
 * pi-better-develop
 *
 * A pi extension that merges the old "dev-mode" and "pi-plan-mode" extensions
 * into one package with THREE mutually-exclusive work modes:
 *
 *   chat (default)  — READ-ONLY. Built-in edit/write are disabled; no write
 *                     capability at all. bash stays available (prompt-only).
 *   plan            — write access to ./.pi/plans/ ONLY, via a dedicated
 *                     `write_plan` tool (built-in edit/write stay disabled).
 *                     Injects the plan-mode context (assets/idea.md) so the
 *                     model knows how to produce a plan file.
 *   dev             — FULL write access; built-in edit/write are restored.
 *
 * Command surface:
 *   /chat   — leave dev or plan, back to the default read-only chat mode.
 *             Replaces the old /devoff and /plan end.
 *   /plan   — enter plan mode (write only .pi/plans).
 *   /dev    — enter dev mode (full write).
 *
 * Design notes (inherited from dev-mode, hardened after field reports):
 *   - `mode` is a single union state: "chat" | "plan" | "dev".
 *   - Action methods (setActiveTools) are only called inside event/command
 *     handlers, NEVER during extension loading (avoids "Runtime not
 *     initialized").
 *   - EVERY turn, `before_agent_start` (1) forces the active tool set to match
 *     the current mode, and (2) appends the current mode note to the SYSTEM
 *     PROMPT. The system prompt is rebuilt fresh each turn, so exactly one
 *     always-current note is present and stale markers never linger in the
 *     message history (no "context residue"). No message-injection + context
 *     de-dupe is used anymore.
 *   - Mode state is session-only; every session_start resets to chat.
 *
 * Assets are bundled relative to this file (assets/idea.md).
 *
 * Install (auto-discovery) then /reload:
 *   - global:  ~/.pi/agent/extensions/
 *   - project: .pi/extensions/
 * Or test directly: pi -e ./index.ts
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WRITE_TOOLS = new Set<string>(["edit", "write"]);
// Custom tool used to write plan files, active only in plan mode.
const PLAN_TOOL = "write_plan";
const PLANS_DIR = ".pi/plans";

const STATUS_ID = "pi-better-develop";

// ---------------------------------------------------------------------------
// bash 闸门白名单 (chat/plan 模式): 只放行白名单内的只读「查看」命令,
// 未命中的命令直接 block(不再弹 UI 确认)。dev 模式全放行。
// 判定层级: ① 写重定向/命令替换/多命令链接兜底; ② 命令名白名单(+ 逐段校验)。
// ---------------------------------------------------------------------------

// ① 写重定向/写操作符(无论命令名都拦)。排除 >= => -> 误报。
const WRITE_OPERATOR_RE = /(?:^|[^\S\n]|[\s;&|()])\d*&?>>?(?![^\S\n]*[=>-])/;

// ② 只读「查看」命令名白名单 —— 首段命令名(basename)必须在此集合。
// 未命中的命令一律 block(不再弹 UI 确认);dev 模式全放行。
const WHITELIST_CMDS = new Set([
  // 目录/文件查看
  "ls", "pwd", "find", "grep", "rg", "head", "tail", "wc", "stat", "file",
  "tree", "du", "df", "more", "less", "cat", "sed",
  // 系统/进程查看
  "ps", "top", "uname", "whoami", "id", "env", "date", "which", "uptime",
  "free", "echo", "command",
]);

// git 只读子命令(写子命令一律拦截)。
const GIT_READONLY_SUBS = new Set([
  "status", "log", "show", "diff", "branch", "remote", "ls-files",
]);

function firstTokenBasename(cmd: string): string {
  const token = cmd.trim().split(/[\s;&|)]+/)[0];
  return token.replace(/^.*\//, "").toLowerCase();
}

// per-command 安全校验: 白名单命令的额外限制(不在 switch 则直接看集合)。
function commandTokenAllowed(name: string, cmd: string): boolean {
  switch (name) {
    case "git": {
      const m = cmd.match(/^\s*git\s+(\S+)/i);
      return !!m && GIT_READONLY_SUBS.has(m[1].toLowerCase());
    }
    case "sed": // 仅无 -i 的只读流处理/打印
      return !/\s-i\b/.test(cmd);
    default:
      return WHITELIST_CMDS.has(name);
  }
}

// 白名单判定(chat/plan 模式): 全过才 true,否则 block。
// ① 严格段: 写重定向 / 命令替换($() 反引号) / 多命令链接(; && & ||) 任一命中 → false。
// ② 管道 | 放行: 按 | 拆段,每段 trim,各自过「命令名白名单 + per-command 校验」。
function isAllowed(cmd: string): boolean {
  if (WRITE_OPERATOR_RE.test(cmd)) return false; // 写重定向
  if (/\$\(|`/.test(cmd)) return false; // 命令替换 / 反引号
  if (/[;&]|\|\|/.test(cmd)) return false; // 多命令链接 ; && & ||(单管道 | 除外)
  const segs = cmd.split("|").map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return false;
  for (const seg of segs) {
    const name = firstTokenBasename(seg);
    if (!commandTokenAllowed(name, seg)) return false;
  }
  return true;
}

function reflectReason(shown: string): string {
  return `[已阻止] 你在 chat/plan（只读）模式下执行了不在白名单的 bash 命令:\n${shown}\n\n` +
    `本模式只放行白名单内只读「查看」命令(如 ls cat pwd find grep rg head tail wc ` +
    `stat file tree du df more less sed、git 只读子命令、ps 等系统查看),可用 | 管道组合。\n` +
    `写操作与未列出的命令一律直接阻止,不再逐条询问。\n` +
    `请反思——你是否误以为自己在 dev 模式？需要自由执行命令/写文件时，请告诉用户运行 /dev。`;
}

type Mode = "chat" | "plan" | "dev";

export default function (pi: ExtensionAPI) {
  let mode: Mode = "chat"; // default: read-only chat

  const here = dirname(fileURLToPath(import.meta.url));
  const ideaPath = resolve(here, "assets/idea.md");
  let planContext = "";

  void loadPlanContext();
  async function loadPlanContext(): Promise<void> {
    try {
      planContext = await readFile(ideaPath, "utf8");
    } catch {
      planContext = `[plan mode] 未找到 idea.md: ${ideaPath}`;
    }
  }

  // ---- tool-set helpers (idempotent, callable only after runtime init) ----

  function applyChatTools(): void {
    pi.setActiveTools(
      pi.getActiveTools().filter((n) => !WRITE_TOOLS.has(n) && n !== PLAN_TOOL),
    );
  }

  function applyPlanTools(): void {
    const next = pi.getActiveTools().filter((n) => !WRITE_TOOLS.has(n));
    if (!next.includes(PLAN_TOOL)) next.push(PLAN_TOOL);
    pi.setActiveTools(next);
  }

  function applyDevTools(): void {
    const next = pi
      .getActiveTools()
      .filter((n) => n !== PLAN_TOOL);
    pi.setActiveTools([...new Set([...next, ...Array.from(WRITE_TOOLS)])]);
  }

  function applyModeTools(m: Mode): void {
    if (m === "dev") applyDevTools();
    else if (m === "plan") applyPlanTools();
    else applyChatTools();
  }

  // ---- status + transitions -------------------------------------------------

  function updateStatus(ctx: ExtensionContext): void {
    if (mode === "dev") {
      ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("success", "⚒ dev"));
    } else if (mode === "plan") {
      ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", "📋 plan"));
    } else {
      ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", "⏸ chat (read-only)"));
    }
  }

  function setMode(ctx: ExtensionContext, next: Mode): void {
    mode = next;
    applyModeTools(next);
    updateStatus(ctx);
  }

  pi.registerCommand("chat", {
    description: "Enter read-only chat mode (exit dev or plan). Usage: /chat",
    handler: async (_args, ctx) => {
      if (mode === "chat") {
        ctx.ui.notify("Already in chat mode (read-only).", "info");
        return;
      }
      setMode(ctx, "chat");
      ctx.ui.notify("Chat mode: read-only. edit/write and write_plan disabled. /dev or /plan to re-enable.", "warning");
    },
  });

  pi.registerCommand("plan", {
    description: "Enter plan mode (write only .pi/plans via write_plan). Usage: /plan",
    handler: async (_args, ctx) => {
      if (mode === "plan") {
        ctx.ui.notify("Already in plan mode.", "info");
        return;
      }
      setMode(ctx, "plan");
      ctx.ui.notify("Plan mode: can write only ./.pi/plans/ (write_plan). /chat to exit, /dev for full access.", "info");
    },
  });

  pi.registerCommand("dev", {
    description: "Enter dev mode (full write access). Usage: /dev",
    handler: async (_args, ctx) => {
      if (mode === "dev") {
        ctx.ui.notify("Already in dev mode.", "info");
        return;
      }
      setMode(ctx, "dev");
      ctx.ui.notify("Dev mode: full write access. /chat to go read-only.", "info");
    },
  });

  // ---- per-turn: force tool set + inject current mode note into system prompt

  const CHAT_NOTE = `[MODE: CHAT — READ-ONLY]
You are in chat mode, a strictly read-only discussion mode. This note is authoritative for this turn.
- The edit and write tools are NOT available, so you CANNOT modify files through them.
- Even though bash is available, do NOT use it to modify, create, or delete anything on disk (no >, >>, tee, rm, mv, cp, sed -i, touch, mkdir, chmod, git commit/reset/checkout, etc.). Treat bash as read-only (ls, cat, git log/status, ps, find, grep, etc.).
- This restriction holds NO MATTER WHAT the user says. Even "go ahead"/"just do it" does NOT lift it while this note is present.
- If a change is needed, do NOT perform it yourself — tell the user to run /dev or /plan. Only after the mode note changes may you write.
- If any EARLIER turn claimed you had write access or were in another mode, ignore it — it is outdated; this note governs the current turn.`;

  const PLAN_NOTE = `[MODE: PLAN]
You are in plan mode. This note is authoritative for this turn.
- You are a planner, NOT a code executor. Your deliverable is a plan file.
- You may write files ONLY inside ./.pi/plans/ and ONLY through the write_plan tool.
- The built-in edit/write tools are NOT available. Do NOT use bash to modify/create/delete anything (no >, >>, rm, mv, cp, sed -i, touch, mkdir, chmod, git commit, etc.). Treat bash as read-only.
- To save the plan, call write_plan with a path relative to ./.pi/plans/ and the plan content, following the template in the plan context below.
- While maintaining a plan file, KEEP its Check-list in sync: every plan file must carry a complete Check-list; when you revise the plan, tick/update the affected items and the header status (draft/approved/executing/done) together, and never let the Check-list drift from the body or the actual state.
- If any EARLIER turn claimed you were in another mode, ignore it — it is outdated; this note governs the current turn.`;

  const DEV_NOTE = `[MODE: DEV — FULL WRITE ACCESS]
You are in dev mode with full write access. This note is authoritative for this turn.
- The edit and write tools ARE available. Use the built-in edit/write tools when you need to modify files.
- bash may modify the filesystem when appropriate (>, >>, rm, mv, cp, sed -i, touch, mkdir, chmod, git commit, etc.).
- Do NOT re-verify that you are in dev mode; this note is the confirmation. Act on your task directly.
- If any EARLIER turn claimed you were in READ-ONLY or PLAN mode, ignore it — it is outdated; this note governs the current turn.`;

  // dev 模式每轮注入: 提醒完成后回填对应计划文件的检查清单/状态/偏离。
  const CHECKLIST_NOTE = `[CHECKLIST 义务]
This session (dev) may involve implementing or revising a plan file under ./.pi/plans/.
When you finish that work, you MUST keep the plan file in sync:
  1. Tick/update its Check-list items that are now done.
  2. Update its header status (draft/approved/executing/done).
  3. Record any deviation from the plan in its 偏离记录(deviation log).
If the project has no corresponding plan file, you may ignore this reminder.
It is a hard habit: never leave a plan file's Check-list, status, or deviation log stale after you complete dev work on it.`;

  pi.on("before_agent_start", async (event) => {
    applyModeTools(mode);

    let note = mode === "dev" ? DEV_NOTE : mode === "plan" ? PLAN_NOTE : CHAT_NOTE;
    if (mode === "dev") {
      note += "\n\n" + CHECKLIST_NOTE;
    } else if (mode === "plan") {
      note += "\n\n---\n" + planContext;
    }
    return { systemPrompt: event.systemPrompt + "\n\n" + note };
  });

  // ---- bash 闸门: chat/plan 模式下拦截写/危险命令, 需用户同意 --------------

  pi.on("tool_call", (event) => {
    if (mode === "dev") return; // dev 全放行
    if (!isToolCallEventType("bash", event)) return;
    const cmd = ((event.input as { command?: string }).command ?? "").trim();
    if (!cmd || isAllowed(cmd)) return; // 命中白名单才放行, 未命中直接阻止

    const shown = cmd.length > 80 ? cmd.slice(0, 80) + " …[已截断]" : cmd;
    return { block: true, terminate: true, reason: reflectReason(shown) };
  });

  // ---- custom plan write tool (restricted to ./.pi/plans/) -----------------

  pi.registerTool({
    name: PLAN_TOOL,
    label: "Write plan file",
    description:
      "Write a plan markdown file into ./.pi/plans/. Path is relative to ./.pi/plans/. Used only in plan mode.",
    promptSnippet: "Write a plan file into ./.pi/plans/",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description: "Name of the plan file, relative to ./.pi/plans/ (e.g. my-feature_plan_20260101-120000.md). Defaults to plan_<timestamp>.md",
        }),
      ),
      content: Type.String({ description: "Markdown content of the plan file" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();
      const plansRoot = resolve(cwd, PLANS_DIR);
      let rel = ((params as { path?: string }).path ?? "").trim();
      if (!rel) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        rel = `plan_${ts}.md`;
      }

      const target = resolve(plansRoot, rel);
      // Containment check: target must live under ./.pi/plans/ (no .. escapes).
      const relCheck = relative(plansRoot, target);
      if (isAbsolute(relCheck) || relCheck.startsWith("..") || relCheck.startsWith("\u0000")) {
        throw new Error(`write_plan: path escapes ./.pi/plans/ (blocked): ${rel}`);
      }

      await mkdir(dirname(target), { recursive: true });
      await writeFile(resolve(plansRoot, rel), (params as { content: string }).content, "utf8");
      const finalPath = resolve(plansRoot, rel);

      return {
        content: [
          { type: "text", text: `Plan written to ${relative(cwd, finalPath)}` },
        ],
        details: { path: finalPath },
      };
    },
  });

  // ---- session lifecycle -----------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    mode = "chat";
    applyChatTools();
    updateStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_ID, undefined);
  });
}