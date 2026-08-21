/**
 * pi-better-develop
 *
 * A pi extension providing THREE mutually-exclusive work modes:
 *
 *   chat (default)  — READ-ONLY. Built-in edit/write are disabled; bash stays
 *                     available but is only discouraged (via system-prompt note,
 *                     not enforced) from writing to disk.
 *   plan            — write access to ./.pi/plans/ ONLY, via a dedicated
 *                     `write_plan` tool (built-in edit/write stay disabled).
 *                     Injects the plan-mode context (assets/idea.md) so the
 *                     model knows how to produce a plan file.
 *   dev             — FULL write access; built-in edit/write are restored.
 *
 * Command surface:
 *   /chat   — leave dev or plan, back to the default read-only chat mode.
 *   /plan   — enter plan mode (write only .pi/plans).
 *   /dev    — enter dev mode (full write).
 *
 * Design notes (hardened after field reports):
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

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WRITE_TOOLS = new Set<string>(["edit", "write"]);
// Custom tool used to write plan files, active only in plan mode.
const PLAN_TOOL = "write_plan";
const PLANS_DIR = ".pi/plans";

const STATUS_ID = "pi-better-develop";

// chat/plan 模式不设代码级 bash 拦截:bash 可用,但通过系统提示注入约束,
// 提醒 agent 不要用 bash 做写操作(见 CHAT_NOTE / PLAN_NOTE)。dev 模式全放行。

type Mode = "chat" | "plan" | "dev";

export default function (pi: ExtensionAPI) {
  let mode: Mode = "chat"; // default: read-only chat

  const here = dirname(fileURLToPath(import.meta.url));
  const ideaPath = resolve(here, "assets/idea.md");
  let planContext = "";

  // Lazy-load plan context ON DEMAND (memoized promise) instead of fire-and-forget
  // at load time. This removes the race where /plan could be entered before the
  // async read resolved, leaving planContext empty for the first plan turn.
  let planContextPromise: Promise<void> | undefined;
  async function loadPlanContext(): Promise<void> {
    if (!planContextPromise) {
      planContextPromise = (async () => {
        try {
          planContext = await readFile(ideaPath, "utf8");
        } catch {
          planContext = `[plan mode] 未找到 idea.md: ${ideaPath}`;
        }
      })();
    }
    return planContextPromise;
  }
  async function ensurePlanContext(): Promise<void> {
    if (mode === "plan" && !planContext && !planContextPromise) {
      await loadPlanContext();
    }
  }

  // ---- tool-set helpers (idempotent, callable only after runtime init) ----

  /** Resolve true when the path exists (including a broken symlink). */
  async function exists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

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

  /** One-sentence reminder label per mode, used for the switch-time hard reminder. */
  function modeLabel(m: Mode): string {
    return m === "dev"
      ? "dev（全写权限）"
      : m === "plan"
        ? "plan（仅可写 .pi/plans）"
        : "chat（只读）";
  }

  function setMode(ctx: ExtensionContext, next: Mode): void {
    const changed = mode !== next;
    mode = next;
    applyModeTools(next);
    updateStatus(ctx);
    if (changed) {
      // Hard reminder: silently queue a one-shot user-visible context message so
      // it lands at maximum recency in the next agent turn. deliverAs "nextTurn"
      // means no forced extra turn / no extra tokens. Complements the per-turn
      // MODE_NOTE injected into the system prompt (belt & suspenders), fighting
      // stale-mode residue after rapid chat->plan->dev->plan->dev switching.
      pi.sendMessage(
        {
          customType: "pi-better-develop/mode",
          content: `[模式切换硬提醒] 你现在处于 ${modeLabel(next)} 模式。`,
          display: true,
        },
        { deliverAs: "nextTurn" },
      );
    }
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
      await ensurePlanContext(); // guarantee plan context is loaded this turn
      if (planContext) note += "\n\n---\n" + planContext;
    }
    return { systemPrompt: event.systemPrompt + "\n\n" + note };
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
      // Refuse to silently clobber an unrelated existing file: allow overwriting
      // ONLY a file that already holds plausible plan content (the "revise same
      // file" workflow), and surface an explicit replace notice so the model is
      // never surprised by a destructive write. Empty / binary / foreign files
      // under the plans dir are treated as untouchable.
      const replace = await exists(target);
      if (replace) {
        let text: string;
        try {
          text = await readFile(target, "utf8");
        } catch (e) {
          // E.g. target is a directory or unreadable — do not clobber it.
          throw new Error(
            `write_plan: refusing to overwrite existing unreadable path ${relative(cwd, target)}: ${(e as Error).message}`,
          );
        }
        const isPlan =
          text.includes("# 计划") ||
          text.includes("# Plan") ||
          text.toLowerCase().includes("check-list") ||
          text.toLowerCase().includes("目标") ||
          text.toLowerCase().includes("objective");
        if (!text.trim() || !isPlan) {
          throw new Error(
            `write_plan: refusing to overwrite existing non-plan file: ${relative(cwd, target)}`,
          );
        }
      }
      await writeFile(target, (params as { content: string }).content, "utf8");

      return {
        content: [
          {
            type: "text",
            text: `Plan ${replace ? "overwritten" : "written"} to ${relative(cwd, target)}${
              replace ? " (WARNING: replaced an existing plan file)" : ""
            }`,
          },
        ],
        details: { path: target, replaced: replace },
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