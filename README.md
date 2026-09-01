# Shared Whiteboard

Human and AI working together at the same whiteboard.

**Live app:** https://bertus37987.github.io/smooth-whiteboard-webmcp/

This project turns the existing Smooth Handwriting vector canvas into a standalone, cross-platform WebMCP application. The browser app is the primary runtime for the OpenAI Developers WebMCP Challenge; the existing Obsidian extension remains available as a secondary adapter.

## What works

- Infinite, coordinate-based canvas with cursor-centred zoom and free pan
- Low-latency freehand input using coalesced pointer events; no handwriting model runs while the pen is down
- Pen-first tools for freehand ink, transient AI ink, smart marker, shapes, arrows, rich text, notes, tables, images, lasso and erasing
- Selection, edge-aware multi-element lasso, moving, eight-handle group resizing, duplication, layer ordering and deletion
- Plain resizable canvas text fields with headings, bullets, numbering, checklists, quotes, code and math styles; sticky notes remain a separate tool
- Sticky notes can be marked with the paperclip action and become an explicit priority region in the next agent turn
- Smart labelled connectors that stay attached to object edges when either endpoint moves or resizes
- Grouping, alignment and equal-gap distribution for agent-created or human-created layouts
- Undo, redo, local browser persistence and JSON import/export
- One arrow submit bound to AI ink, lasso selection, recent highlights and recent edits—no embedded chat bar
- Blue glowing AI Pen: draw spatial instructions for the agent without adding permanent canvas ink
- Alternating Human ↔ Agent turns with a wait tool, lease token and stale-revision protection
- Separate red glowing agent markers with a hover explanation until the contribution is accepted or undone
- Agent typography (sans, serif, mono and handwriting roles), text alignment/weight/style, text highlighting, filled shapes, rounded corners, line styles and one- or two-headed arrows
- Structured editable visuals: study notes, explainers, timelines, comparisons, hierarchies, UI wireframes, flowcharts, mindmaps, research briefs, calculations and plots
- Optional English handwriting assistance using the browser/OS recognizer. It runs locally after pen-up, never replaces visible ink and can be disabled; unsupported browsers retain only gentle geometric smoothing
- Human-editable agent output with a single Accept / Undo decision
- Rounded pen-first black, white and grey interface with cache-safe high-contrast icons, contextual selection actions and no logo or filler content

## WebMCP interface

The app registers eight tools through `document.modelContext`:

1. `start_whiteboard_session` enters the alternating session.
2. `wait_for_human_turn` waits for the submit arrow and claims the new turn.
3. `inspect_whiteboard` reads the latest board or its prioritized human context.
4. `focus_whiteboard_region` moves the shared camera to a relevant region.
5. `publish_agent_plan` exposes one concise next-step line before editing.
6. `apply_whiteboard_changes` creates and edits text, notes, tables, frames, highlights, shapes, arrows and custom paths.
7. `create_structured_visual` compiles higher-level learning, diagram, data and UI layouts into ordinary editable objects.
8. `complete_whiteboard_contribution` ends the turn and exposes Accept / Undo to the human.

The board state—not an agent's previous output—is always the source of truth. Agent-created items are normal canvas items, so the human can move, resize, rewrite or remove them before the next inspection.

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
- `web-src/model.ts`: infinite-board document and canvas operations
- `web-src/compositions.ts`: high-level editable visual composers
- `web-src/store.ts`: revisioned state, persistence, history and agent rollback
- `web-src/renderer.ts`: infinite-canvas renderer, camera, selection and lasso
- `web-src/app.ts`: human interactions and collaboration UI
- `web-src/webmcp.ts`: small WebMCP capability surface
- `src/main.ts`, `src/pdf-annotation.ts`: optional Obsidian adapter

## License

MIT. The bundled Google Ink Stroke Modeler dependency remains under Apache-2.0; see `THIRD_PARTY_NOTICES.md`.

The finished-product roadmap and release gates are documented in [`docs/PRODUCT_PLAN.md`](docs/PRODUCT_PLAN.md).
