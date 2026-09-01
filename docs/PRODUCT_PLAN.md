# Smooth Whiteboard — plan for the finished product

## Product definition

Smooth Whiteboard is a pen-first shared visual workspace. The human and a browser agent edit the same ordinary canvas objects. The application contains no separate chatbot or generated preview layer: every agent result remains movable, resizable, rewritable, restylable and deletable by the human.

## Interaction model

1. The human draws, writes or imports an image. A separate blue AI Pen can add temporary spatial instructions without changing the artifact.
2. The thin command bar targets the whole canvas, the current lasso/selection, the AI-Pen overlay or a combination.
3. The agent inspects the latest revision before every change.
4. The agent either edits precise existing objects or composes a structured visual.
5. Changes appear progressively on the live canvas.
6. The human accepts, undoes or directly edits the result.
7. The next agent turn starts from that human-edited state.

## Agent capability surface

The WebMCP API intentionally stays small while covering the complete visual workflow:

- `inspect_whiteboard`: reads the current revision, viewport, selection, instruction, transient AI-Pen coordinates, groups and editable object geometry.
- `apply_whiteboard_changes`: low-level precision editing for styled text, text highlights, colors, strokes, filled shapes, arrows, smart connectors, movement, resizing, styling, grouping, duplication, alignment, distribution, layers and deletion.
- `create_structured_visual`: high-level composition for UI wireframes, flowcharts, mindmaps, research briefs, calculation steps and plotted graphs. It compiles to normal low-level canvas objects.
- `complete_whiteboard_contribution`: ends a progressive contribution and exposes the human Accept/Undo decision.

This split lets the agent create custom drawings through points and strokes without requiring a special tool for every possible picture. Rewriting or shortening selected text uses `update_text`; rearranging an explanation uses movement, grouping, alignment and distribution.

## Visual structures

### UI design

- screen/frame, header, sidebar, cards, buttons, inputs and text regions
- exact dimensions and world coordinates when needed
- editable grouped labels and containers
- human can draw directly on top of the proposal

### Flowcharts and mindmaps

- grouped labelled nodes
- edge-attached smart connectors
- decision nodes and connector labels
- automatic default layout with optional exact coordinates

### Research and learning

- titled research briefs with editable section cards
- step-by-step calculations with explanations
- plotted data/function series with labelled axes
- agent can shorten, expand or reorder any selected passage afterward

## Release stages

### 0.10 — visual collaboration foundation

- dark, high-contrast pen toolbar with self-contained SVG icons
- initial global and selected agent context
- groups, alignment, distribution and duplication
- structured visual composer and broader WebMCP schema
- browser and schema regression tests

### 0.11 — spatial agent collaboration

- blue glowing, non-permanent AI-Pen instruction layer
- sticky tools: pen, AI Pen, shapes, image and lasso remain active until the human explicitly changes tools
- red glowing Agenten-Markierung for every created or touched object, with an explanatory hover label
- font roles, weight, italic, alignment, text marking, filled shapes, rounded corners, line styles and bidirectional arrows for WebMCP

### 0.12 — professional canvas controls

- chatless arrow submit and alternating Human ↔ Agent turns with leases
- color picker, rich resizable text, notes, tables and feature toggles
- local, optional English handwriting recognition metadata for agent readability
- study notes, timelines, comparisons, hierarchies and visual explainers
- priority regions for AI ink, selection, highlights and recent edits

### 0.13 — export and precision controls

- snapping guides, equal-spacing hints and keyboard nudging
- stroke-width/fill/opacity inspector
- multi-select group/ungroup controls
- richer graph ticks, legends and grid lines
- PNG, SVG and paginated PDF export

### 1.0 — finished challenge release

- complete Human → Lasso/Canvas instruction → Agent → Human edit loop
- tested UI, flowchart, mindmap, research, math and graph demos
- public cross-platform deployment with cache-safe assets
- resilient persistence and document migrations
- accessibility and responsive-layout audit
- optional non-destructive handwriting improvement remains off by default until it passes pen-latency and stroke-preservation tests

## Completion gates

- Every WebMCP mutation rejects stale revisions and invalid geometry.
- Every structured visual decomposes into ordinary editable elements.
- Moving a grouped node keeps its label; moving a connected node keeps its connector.
- The submit arrow works with an empty canvas, AI ink and a lasso selection.
- Agent changes can be accepted, undone or manually edited.
- Chrome shows every tool icon at normal and high-DPI scaling.
- The public deployment passes typecheck, tests, build and browser smoke tests.
