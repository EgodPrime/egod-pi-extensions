/**
 * pi-token-speed
 *
 * A small pi extension that shows the current generation speed (tokens/second)
 * as an extra item in the footer status bar.
 *
 * How it works:
 *   - During generation, each `message_update` stream delta (text / thinking /
 *     toolcall) is converted to an approximate token count via a character
 *     heuristic, and the live value is the WHOLE-TURN running average
 *     (cumulative tokens ÷ elapsed since the turn started). This converges to
 *     the final exact value, so the live number doesn't jump wildly.
 *   - Before the first token arrives (the initial "Working..." phase) the
 *     status is hidden rather than showing a misleading "…".
 *   - When an assistant message ends, the accurate `usage.output` token count
 *     is used to compute the final average, which is then frozen (dimmed) until
 *     the next generation starts.
 *
 * Choices (confirmed with the user):
 *   - Live semantics: whole-turn running average (most consistent with final).
 *   - After end: keep the last value (dimmed) until overwritten by next turn.
 *   - Accuracy: char-based token estimate live, exact `usage.output` at end.
 *   - Initial phase (no token yet): hide the status.
 *
 * Install (auto-discovery) then /reload:
 *   - global:    ~/.pi/agent/extensions/
 *   - project:   .pi/extensions/
 * Or test directly:  pi -e ./index.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "gen-speed";
// All stream delta event types that count as output tokens.
// text = visible reply, thinking = reasoning process, toolcall = tool JSON args.
const TOKEN_DELTA_TYPES = new Set<string>(["text_delta", "thinking_delta", "toolcall_delta"]);

/**
 * Rough token estimate for a delta chunk. Reasoning/toolcall deltas and text
 * deltas are tokenized by the provider, so a pure char count is approximate:
 *   - CJK / fullwidth chars ≈ 1 token per character
 *   - everything else ≈ 1 token per ~4 characters (Latin text heuristic)
 * Floors to 1 for any non-empty chunk so we never register zero output.
 */
function estTokens(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x2e80 && cp <= 0x2eff)) {
      n += 1; // CJK
    } else {
      n += 0.25; // Latin / other
    }
  }
  return Math.max(1, Math.round(n));
}

export default function (pi: ExtensionAPI) {
  let turnStart = 0;
  let streamTokens = 0;

  function reset(): void {
    turnStart = 0;
    streamTokens = 0;
  }

  function format(r: number | undefined): string {
    if (r === undefined || !isFinite(r)) return "… tok/s";
    return `${r.toFixed(1)} tok/s`;
  }

  function show(ctx: ExtensionContext, r: number | undefined, live: boolean): void {
    const theme = ctx.ui.theme;
    const text = `⚡ ${format(r)}`;
    ctx.ui.setStatus(STATUS_ID, live ? theme.fg("accent", text) : theme.fg("dim", text));
  }

  // --- generation lifecycle ----------------------------------------------

  pi.on("message_start", (_event, ctx) => {
    reset();
    ctx.ui.setStatus(STATUS_ID, undefined); // hide until the first token arrives
  });

  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const ev = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
    if (!ev || !ev.type || !TOKEN_DELTA_TYPES.has(ev.type)) return;

    const now = Date.now();
    if (turnStart === 0) turnStart = now;
    streamTokens += estTokens(ev.delta ?? "");

    const elapsed = (now - turnStart) / 1000;
    const rate = streamTokens >= 1 && elapsed > 0 ? streamTokens / elapsed : undefined;
    show(ctx, rate, true);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const usage = (event.message as { usage?: { output?: number } }).usage;
    const exact = typeof usage?.output === "number" ? usage.output : streamTokens;
    const elapsed = (Date.now() - turnStart) / 1000;
    const final = elapsed > 0 ? exact / elapsed : undefined;

    show(ctx, final, false);
  });

  // --- cleanup -----------------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    reset();
    ctx.ui.setStatus(STATUS_ID, undefined);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_ID, undefined);
  });
}