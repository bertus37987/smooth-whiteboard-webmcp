# Shared Whiteboard

Human and AI working together at the same whiteboard.

**Live app:** https://bertus37987.github.io/smooth-whiteboard-webmcp/

This project turns the existing Smooth Handwriting vector canvas into a standalone, cross-platform WebMCP application. The browser app is the primary runtime for the OpenAI Developers WebMCP Challenge; the existing Obsidian extension remains available as a secondary adapter.

## What works

- Infinite, coordinate-based canvas with cursor-centred zoom and free pan
- Low-latency freehand input using coalesced pointer events; no handwriting model runs while the pen is down
- Pen-first human tools for freehand ink, transient AI ink, smart marker, shapes, arrows, rich text, notes, images, artboards, hand panning, lasso and pixel erasing; tables are deliberately agent-only
- An AI Lasso beside the tools: circle any objects and they glow blue and travel with the next request, without touching the current selection
- Selection, edge-aware multi-element lasso, moving, eight-handle group resizing, duplication, layer ordering and deletion
- Plain resizable canvas text fields with headings, bullets, numbering, checklists, quotes, code and math styles; sticky notes remain a separate tool
- Sticky notes can be marked with the paperclip action and become an explicit priority region in the next agent turn
- Smart labelled connectors that stay attached to object edges when either endpoint moves or resizes
- Grouping, alignment and equal-gap distribution for agent-created or human-created layouts
- Undo, redo, local browser persistence, JSON import and PNG/SVG/multi-page PDF/JSON export
- Bottom prompt dock with one arrow submit, auto-growing user text and visible context chips for AI ink, selection, attachments and the whole canvas—no embedded chat bar
- Blue glowing AI Pen: draw spatial instructions for the agent without adding permanent canvas ink
- Alternating Human ↔ Agent turns with a wait tool, lease token and stale-revision protection
- Separate red glowing agent markers with a hover explanation until the contribution is accepted or undone
- Agent typography (sans, serif, mono and handwriting roles), text alignment/weight/style, text highlighting, filled shapes, rounded corners, line styles and one- or two-headed arrows
- Structured editable visuals: study notes, explainers, timelines, comparisons, hierarchies, UI wireframes, flowcharts, mindmaps, research briefs, calculations and plots
- Every generated card, note and page is measured against the real font, so agent layouts do not overflow their boxes
- Hand-drawn sketch rendering with a deterministic wobble, identical on screen and in PNG/SVG/PDF export
- Style follows the context: what the agent parents to an artboard comes out clean and typeset, what it puts on the open canvas comes out hand-drawn, and either default can be overridden per object
- Colour where it carries meaning: mindmap branches, decision nodes, timeline markers and comparison columns take accents from one shared set, and the agent is told when to reach for them
- Routed connectors (straight, orthogonal, curved), flowchart diamonds and triangles, annotation callouts with leader lines, smoothed free-hand paths and fourteen icons
- Guided explanations show the agent's own step text, remember which step is open across reloads, and can be driven by the agent
- Optional English handwriting assistance using the browser/OS recognizer. It runs locally after pen-up, never replaces visible ink and can be disabled; unsupported browsers retain only gentle geometric smoothing
- Agent output appears as one neutral dashed proposal batch with an atomic Accept / Reject decision; rejecting restores the complete pre-agent state
- Rounded pen-first black, white and grey interface with cache-safe high-contrast icons, contextual selection actions and no logo or filler content

## WebMCP interface

The app registers eight tools through `document.modelContext`:

1. `start_whiteboard_session` enters the alternating session.
2. `wait_for_human_turn` waits for the submit arrow and claims the new turn.
3. `inspect_whiteboard` reads the latest board or its prioritized human context.
4. `focus_whiteboard_region` moves the shared camera to a relevant region.
5. `publish_agent_plan` exposes one concise next-step line before editing.
6. `apply_whiteboard_changes` creates and edits text, notes, agent-only tables, artboards, icons, highlights, filled shapes, arrows, custom paths, step sequences and temporary red agent comments.
7. `create_structured_visual` compiles higher-level learning, diagram, data, UI-mockup and guided-explanation layouts into ordinary editable objects.
8. `complete_whiteboard_contribution` ends the turn and exposes Accept / Reject to the human.

`apply_whiteboard_changes` covers creation (text, notes, callouts, tables, frames, artboards, highlights,
shapes including diamonds and triangles, arrows, routed connectors, icons, smoothed paths, agent comments),
editing (move, resize, rewrite, restyle, lock, reorder, group, re-parent, duplicate, delete), layout
(`align`, `distribute`, `auto_layout`, `fit_to_content`) and teaching (`set_explanation_sequence`,
`present_step`). Its answer carries `lintIssues` for the elements just touched, so the agent can fix an
overflow, an overlap, an unlabelled control or a contrast problem inside the same turn.
`inspect_whiteboard` additionally returns `designSystem` (the shared palette, accents, spacing and type scale, plus guidance on when to use colour and when drawing comes out clean) and
`activePresentation` (the guided-explanation step the human is looking at).

The board state—not an agent's previous output—is always the source of truth. Agent-created items are normal canvas items, so the human can move, resize, rewrite or remove them before the next inspection.

### Turn protocol

```
idle → waiting → queued → claimed → planning → working → review → complete | cancelled → waiting
```

Every tool answer carries the same capability block, so the model never has to infer what it may do:

```json
{ "state": "waiting", "canWrite": false, "hasLease": false, "nextAction": "wait_for_human_turn" }
{ "state": "claimed", "canWrite": true,  "hasLease": true, "leaseToken": "…", "nextAction": "inspect_whiteboard" }
{ "state": "review",  "canWrite": false, "awaitingHumanDecision": true, "nextAction": "wait_for_human_decision" }
```

Rules the runtime enforces, not just the prose:

- Writing requires an active turn **and** that turn's `leaseToken`; the four write tools and `focus_whiteboard_region` require it in their schema too. The lease dies when the turn reaches review, accept, reject or a page reload.
- Each human submit freezes its own context: prompt, selection, AI-pen gesture (resolved to the elements it points at), attachments, recent human edits and the regions the human deleted. Live selection changes after Send do not leak into the running turn.
- A batch is validated as a whole. An id collision — including the concrete ids composites such as notes, frames and tables generate — or a target that does not exist applies zero operations.
- Streamed operations revalidate turn, lease, status and the WebMCP `AbortSignal` before each step; a cancelled execution rolls the whole proposal back.
- Accept / Reject only appear in `review`; while the agent writes, human board mutations are locked by one central rule instead of per-handler checks.
- Session bookkeeping (claim, plan, status, lease) never bumps the canvas revision, so `baseRevision` only becomes stale when the visible board really changed.

## Run the web app

```bash
npm install
npm run typecheck
npm test
npm run web:build
python3 -m http.server 4173 -d web-dist
```

Open `http://127.0.0.1:4173/`. WebMCP works in ChatGPT's in-app browser and in Chrome when its experimental WebMCP support is enabled. In other browsers, every human whiteboard feature remains available.

## Deploy

The repository includes `vercel.json`. Import it into Vercel or run:

```bash
vercel --prod
```

Vercel builds `web-dist/` with `npm run web:build`. The output is static and needs no account system, database or platform-specific runtime.

## Obsidian adapter

The earlier Obsidian plugin can still be built with `npm run build`. It keeps vector handwriting blocks, shapes, multi-page notes, imports/exports and non-destructive PDF ink. Its Obsidian APIs are isolated from the standalone entry point: the web bundle contains no `obsidian` import.

## Architecture

- `src/document.ts`, `src/strokes.ts`, `src/shapes.ts`, `src/rendering.ts`: reused canvas core
- `web-src/model.ts`: infinite-board document, canvas operations, connector routing and the design linter
- `web-src/measure.ts`, `web-src/theme.ts`: real text measurement and the shared palette/spacing scale
- `web-src/compositions.ts`: high-level editable visual composers
- `web-src/store.ts`: revisioned state, persistence, history and agent rollback
- `web-src/renderer.ts`: infinite-canvas renderer, camera, selection and lasso
- `web-src/collaboration.ts`: turn state machine, lease, agent proposal transaction and human mutation ledger
- `web-src/app.ts`: human interactions and collaboration UI
- `web-src/webmcp.ts`: small WebMCP capability surface
- `src/main.ts`, `src/pdf-annotation.ts`: optional Obsidian adapter

## License

MIT. The bundled Google Ink Stroke Modeler dependency remains under Apache-2.0; see `THIRD_PARTY_NOTICES.md`.

The finished-product roadmap and release gates are documented in [`docs/PRODUCT_PLAN.md`](docs/PRODUCT_PLAN.md).
