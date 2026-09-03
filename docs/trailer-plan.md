# Trailer plan — real whiteboard, WebMCP explained on the whiteboard

**Challenge focus:** build apps where **agents and humans collaborate using WebMCP**. The trailer must
show that, with **real footage of the real whiteboard**, and it must show *how it works in the first
~50 seconds* (hackathon judges decide fast). Cut snappy — OpenAI-launch pacing.

## The idea (why it's cool, not fake)

The whiteboard **explains the very thing it demonstrates**: a real AI agent draws the WebMCP turn
protocol *live*, on the board, while the human collaborates — points with the pen, and the agent
revises in place. The medium is the message. No recreated UI, no mockups: it is the actual app,
actually drawing, driven by the actual tools.

## Shot list (first 50s carries the whole "how")

| t | on screen | caption (cut in, 2–4 words) |
|---|-----------|------------------------------|
| 0–3s | empty board, cursor, prompt bar | "One shared canvas." |
| 3–8s | human **types** "Explain how WebMCP works", hits send | "You ask." |
| 8–12s | prompt queues → agent claims (bar shows it) | "A real agent takes the turn." |
| 12–34s | agent **draws the turn protocol live** — title, then the You↔Agent sequence building message by message | "It draws — live." |
| 34–40s | the `registerTool()` note appears | "The page hands it real tools." |
| 40–46s | human **points with the pen**, agent adds a note / revises | "You point. It revises." |
| 46–50s | dashed proposal frame → human clicks **Accept ✓** | "You stay the gate." |
| 50–60s | fast montage of other boards (UI, math, biology) | "Explain. Plan. Design." |
| 60–68s | title card + URL | "Collaborative Whiteboard" |

Keep every caption ≤4 words, hard cuts, no slow fades. Let the drawing motion be the hero.

## How to capture (next session — Playwright MCP)

1. `browser_navigate` to `https://bertus37987.github.io/smooth-whiteboard-webmcp/bridge.html`
   (Playwright's tab is foreground in its own context, so the 35 ms streaming is NOT throttled and
   the drawing looks live.)
2. Start video: Playwright records the context to `.webm` (`recordVideo`), or capture a dense
   screenshot burst and assemble.
3. Run `docs/demo-trailer-script.js` in the page (via `browser_evaluate`) — it plays the whole
   narrative on the real board, paced for recording (~45 s). It types the prompt, the agent draws
   the protocol, the human points, the agent revises, the human accepts.
4. Separately capture the montage boards (already rendered clean in `demo-video-assets/board-*.png`,
   English) or re-shoot them live for consistency.

## How to cut (next session — @studiomeyer-io/mcp-video)

- Trim the raw `.webm` to the beats above; speed-ramp the drawing (1.3–1.6×) so it stays snappy but
  readable; hold 0.5 s on the finished diagram.
- Hard cuts between beats. Add the short captions as overlays (system font, bottom-left, high
  contrast). Optional soft whoosh on cut.
- End card: black, "Collaborative Whiteboard · Human + AI · one canvas · over WebMCP", URL.
- Export 1080p (or 1080×1920 vertical variant if the submission wants it), H.264, ~60–68 s total.

## Assets already prepared

- `docs/demo-trailer-script.js` — the self-playing on-board demo (real tools, real turn).
- `demo-video-assets/board-{cell,ui,math,photo}.png` — clean English board renders for the montage.
- `../demo-video/` — the Remotion project (title/end cards + montage) if we want composed intro/outro
  around the real footage.

## Known good, reusable facts

- `?instant` on the bridge URL removes the per-op delay (for still capture only; NOT for the trailer —
  we want the live streaming).
- The human is always the gate: every agent draw is a proposal until **Accept**; **Reject** rolls back
  exactly what the agent touched; the human can draw beside the agent the whole time.
