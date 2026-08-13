# pi-token-speed

A small [pi](https://github.com/earendil-works/pi-coding-agent) extension that shows the
current **generation speed (tokens/second)** as an extra item in the footer status bar.

## What it does

- While pi streams a response, it counts `message_update` events whose
  `assistantMessageEvent.type === "text_delta"` as an approximation of output tokens and
  computes a **live rolling tok/s** over a ~2s sliding window. The value updates in real
  time in the footer (`⚡ 23.4 tok/s`, accent color).
- When the assistant message ends, it uses the accurate `usage.output` token count to
  correct the value and **freezes** it (dimmed) until the next generation starts.

## Design choices

- **Live + correct**: show a rolling estimate during streaming, then snap to the exact
  average at message end.
- **Keep last value**: after a response, the final tok/s stays in the footer until the
  next generation overwrites it.
- **Approximation**: during streaming the value is an estimate (one token per
  `text_delta` event); the end-of-turn value is accurate via `usage.output`.

## Install

```
mkdir -p ~/.pi/agent/extensions
cp index.ts ~/.pi/agent/extensions/token-speed.ts
```

Then run `/reload` in pi (auto-discovery loads `.pi/agent/extensions/*.ts`).

To type-check while developing:

```
npm run typecheck
```

## Test directly

```
pi -e ./index.ts
```