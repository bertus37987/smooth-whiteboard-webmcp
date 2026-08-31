# Shared Whiteboard

Human and AI working together at the same whiteboard.

**Live app:** https://bertus37987.github.io/smooth-whiteboard-webmcp/

This project turns the existing Smooth Handwriting vector canvas into a standalone, cross-platform WebMCP application. The browser app is the primary runtime for the OpenAI Developers WebMCP Challenge; the existing Obsidian extension remains available as a secondary adapter.

## What works

- Infinite, coordinate-based canvas with cursor-centred zoom and free pan
- Low-latency freehand input using coalesced pointer events; no handwriting model runs while the pen is down
- Rectangle, ellipse, arrow, text, image and eraser tools
- Selection, edge-aware multi-element lasso, moving, eight-handle group resizing, duplication, layer ordering and deletion
- Custom multi-line text boxes that can be freely dragged, resized, restyled and edited by double-clicking
- Smart labelled connectors that stay attached to object edges when either endpoint moves or resizes
- Undo, redo, local browser persistence and JSON import/export
- Human instruction bound to the current lasso selection or the complete board
- Progressive agent operations against the latest board revision
- Human-editable agent output with a single Accept / Undo decision
- Rounded pen-first black, white and grey interface with semantic controls, contextual selection actions and no logo or filler content

## WebMCP interface

The app registers three meaningful tools through `document.modelContext`:

1. `inspect_whiteboard` returns the latest revision, viewport, pending human instruction, selection bounds and editable elements.
2. `apply_whiteboard_changes` creates, connects, moves, resizes, styles, reorders, edits or deletes objects progressively. A stale `baseRevision` is rejected so an agent cannot overwrite newer human work.
3. `complete_whiteboard_contribution` ends a contribution and exposes Accept / Undo to the human.

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
- `web-src/store.ts`: revisioned state, persistence, history and agent rollback
- `web-src/renderer.ts`: infinite-canvas renderer, camera, selection and lasso
- `web-src/app.ts`: human interactions and collaboration UI
- `web-src/webmcp.ts`: small WebMCP capability surface
- `src/main.ts`, `src/pdf-annotation.ts`: optional Obsidian adapter

## License

MIT. The bundled Google Ink Stroke Modeler dependency remains under Apache-2.0; see `THIRD_PARTY_NOTICES.md`.
