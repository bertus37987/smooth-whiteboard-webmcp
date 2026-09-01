import { ImageElement, PageElement, ShapeElement, StrokeElement } from "../src/document";
import { InkPoint, beautifyStroke } from "../src/strokes";
import { optimizeShape } from "../src/shapes";
import { BoardRenderer, SelectionHandle } from "./renderer";
import { BoardStore } from "./store";
import { BoardTool, CanvasOperation, CollaborationTurn, PriorityRegion, boardBounds, elementSummary, estimateTextHeight, isCanvasOperation, lassoElements, migrateBoard, scaleElement, translateElement } from "./model";
import { VisualCompositionInput, composeVisual, isVisualComposition } from "./compositions";
import { registerWhiteboardTools } from "./webmcp";
import { EnglishHandwritingAssist } from "./handwriting";

const icons: Record<string, string> = {
  select: '<path d="M5 3l14 9-7 2-3 7z"/><path d="M13 14l5 5"/>', hand: '<path d="M8 11V7a2 2 0 014 0v3-5a2 2 0 014 0v5-3a2 2 0 014 0v4-2a2 2 0 014 0v5c0 5-3 7-7 7h-1c-3 0-5-2-7-5l-2-3a2 2 0 013-2l2 2"/>',
  pen: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 7l3 3"/>', rectangle: '<rect x="4" y="5" width="16" height="14" rx="1"/>', ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>', arrow: '<path d="M4 12h15M14 7l5 5-5 5"/>',
  "ai-pen": '<path d="M4 20l4-1 10-10-3-3L5 16z"/><path d="M18 3v4M16 5h4M20 11v3M18.5 12.5h3"/>',
  marker: '<path d="M4 17l9-12 6 5-9 11H5z"/><path d="M3 21h18"/>', text: '<path d="M5 6V4h14v2M12 4v16M8 20h8"/>', sticky: '<path d="M5 3h14v13l-5 5H5z"/><path d="M14 21v-5h5"/>', table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16M15 4v16"/>', image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="M4 17l5-5 4 4 2-2 5 4"/>', lasso: '<path d="M19 8c0-3-3-5-7-5S4 5 4 9s4 6 9 6c4 0 7-2 7-5M13 15c0 4-2 6-5 6-2 0-3-1-3-2s1-2 3-2c2 0 4 2 5 4"/>',
  eraser: '<path d="M7 19h12M4 14l8-9a2 2 0 013 0l4 4a2 2 0 010 3l-7 7H8l-4-3a2 2 0 010-2z"/>', undo: '<path d="M9 7l-5 5 5 5"/><path d="M5 12h8a6 6 0 016 6"/>', redo: '<path d="M15 7l5 5-5 5"/><path d="M19 12h-8a6 6 0 00-6 6"/>',
  fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>', trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>', check: '<path d="M5 12l4 4 10-10"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>',
  send: '<path d="M3 12h12M11 7l5 5-5 5"/><path d="M19 7v10"/>', settings: '<path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h8M16 18h4"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="14" cy="18" r="2"/>', attach: '<path d="M9 12.5l5.2-5.2a3 3 0 114.2 4.2l-7.1 7.1a5 5 0 11-7.1-7.1l7.1-7.1"/><path d="M8 15.5l7.1-7.1"/>', edit: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 7l3 3"/>', copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 00-2-2H5a2 2 0 00-2 2v9a2 2 0 002 2h3"/>',
  back: '<rect x="4" y="8" width="10" height="10" rx="1"/><path d="M10 8V4h10v10h-6"/>', front: '<rect x="10" y="4" width="10" height="10" rx="1"/><path d="M14 14v4H4V8h6"/>', minus: '<path d="M6 12h12"/>', plus: '<path d="M12 6v12M6 12h12"/>'
};

function icon(name: string): string { return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[name]}</svg>`; }
function uuid(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }
function byId<T extends HTMLElement>(id: string): T { const element = document.getElementById(id); if (!element) throw new Error(`Missing ${id}`); return element as T; }
function operationTargetIds(operation: CanvasOperation): string[] {
  if ("ids" in operation && Array.isArray(operation.ids)) return operation.ids;
  if (["resize", "update_text", "update_points"].includes(operation.type) && "id" in operation && typeof operation.id === "string") return [operation.id];
  if (operation.type === "connect") return [operation.fromId, operation.toId];
  return [];
}

interface Interaction {
  mode: "pan" | "draw" | "instruction" | "marker" | "shape" | "table" | "lasso" | "move" | "resize" | "erase";
  pointerId: number; startClient: { x: number; y: number }; startWorld: InkPoint; elementId?: string;
  before?: Map<string, PageElement>; beforeBounds?: { minX: number; minY: number; maxX: number; maxY: number }; checkpointed?: boolean;
  additive?: boolean;
  handle?: SelectionHandle;
  instructionIndex?: number;
  markerId?: string;
}

export class WhiteboardApp {
  private readonly store = new BoardStore();
  private readonly canvas = byId<HTMLCanvasElement>("board");
  private readonly renderer = new BoardRenderer(this.canvas, () => this.store.document.elements, () => new Set(Object.values(this.store.document.connections ?? {}).map((connection) => connection.labelId).filter((id): id is string => Boolean(id))));
  private tool: BoardTool = "pen";
  private penColor = "#080808";
  private opacity = 1;
  private interaction: Interaction | null = null;
  private spaceDown = false;
  private readonly status = byId<HTMLSpanElement>("status");
  private readonly review = byId<HTMLDivElement>("review");
  private readonly agentMarkerTip = byId<HTMLDivElement>("agent-marker-tip");
  private readonly imageInput = byId<HTMLInputElement>("image-input");
  private readonly abort = new AbortController();
  private readonly handwriting = new EnglishHandwritingAssist();
  private handwritingTimer = 0;
  private recentHumanStrokeIds: string[] = [];
  private recentHumanEditIds = new Set<string>();
  private turnWaiters: Array<(turn: Record<string, unknown>) => void> = [];

  constructor() {
    this.renderer.instructionInk = structuredClone(this.store.document.turn?.instructionInk ?? []);
    this.bindToolbar(); this.bindSelectionTools(); this.bindCanvas(); this.bindKeyboard(); this.bindCollaboration(); this.bindSettings(); this.bindFiles();
    this.store.addEventListener("change", () => { this.renderer.request(); this.updateUi(); });
    this.renderer.request(); this.updateUi();
    void registerWhiteboardTools({ session: () => this.session(), waitForTurn: (timeout) => this.waitForTurn(timeout), inspect: (scope) => this.inspect(scope), focus: (bounds) => this.focus(bounds), publishPlan: (summary, lease) => this.publishPlan(summary, lease), apply: (operations, revision, lease) => this.applyAgentOperations(operations, revision, 160, 35, lease), compose: (input, revision, lease) => this.composeAgentVisual(input, revision, lease), complete: (summary, lease) => this.completeAgent(summary, lease) }, this.abort.signal)
      .then((available) => this.setStatus(available ? "WebMCP bereit" : "Browser ohne WebMCP – Zeichnen bleibt vollständig verfügbar", 2600))
      .catch(() => this.setStatus("WebMCP konnte nicht registriert werden", 2600));
  }

  private bindToolbar(): void {
    document.querySelectorAll<HTMLButtonElement>("button[data-tool]").forEach((button) => {
      const tool = button.dataset.tool as BoardTool; button.innerHTML = icon(tool); button.addEventListener("click", () => this.setTool(tool));
    });
    for (const [id, name, action] of [
      ["undo", "undo", () => this.store.undo()], ["redo", "redo", () => this.store.redo()], ["fit", "fit", () => { this.renderer.fitAll(); this.updateContextPrompt(); }], ["clear", "trash", () => this.clearBoard()]
    ] as const) { const button = byId<HTMLButtonElement>(id); button.innerHTML = icon(name); button.addEventListener("click", action); }
    byId<HTMLButtonElement>("image-tool").addEventListener("click", () => this.imageInput.click());
    document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((button) => button.addEventListener("click", () => {
      this.penColor = button.dataset.color ?? "#080808";
      byId<HTMLInputElement>("color-native").value = this.penColor; byId<HTMLInputElement>("color-hex").value = this.penColor;
      document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((candidate) => candidate.classList.toggle("is-active", candidate === button));
    }));
    byId<HTMLButtonElement>("settings-toggle").innerHTML = icon("settings");
    byId<HTMLButtonElement>("submit-turn").innerHTML = icon("send");
    byId<HTMLButtonElement>("color-picker-toggle").addEventListener("click", () => this.togglePopover("color-popover"));
    byId<HTMLButtonElement>("settings-toggle").addEventListener("click", () => this.togglePopover("settings-popover"));
    this.setTool("pen");
  }

  private setTool(tool: BoardTool): void {
    this.tool = tool; this.canvas.dataset.activeTool = tool; this.canvas.style.cursor = "";
    document.querySelectorAll<HTMLButtonElement>("button[data-tool]").forEach((button) => button.classList.toggle("is-active", button.dataset.tool === tool));
  }

  private togglePopover(id: string): void {
    for (const candidate of ["color-popover", "settings-popover"]) { const element = byId<HTMLElement>(candidate); element.hidden = candidate === id ? !element.hidden : true; }
  }

  private bindSelectionTools(): void {
    for (const [id, name] of [["duplicate", "copy"], ["send-back", "back"], ["bring-front", "front"], ["edit-text", "edit"], ["text-smaller", "minus"], ["text-larger", "plus"], ["attach-agent", "attach"], ["delete-selection", "trash"]] as const) byId<HTMLButtonElement>(id).innerHTML = icon(name);
    byId<HTMLButtonElement>("duplicate").addEventListener("click", () => this.duplicateSelection());
    byId<HTMLButtonElement>("send-back").addEventListener("click", () => this.reorderSelection("back"));
    byId<HTMLButtonElement>("bring-front").addEventListener("click", () => this.reorderSelection("front"));
    byId<HTMLButtonElement>("edit-text").addEventListener("click", () => { const text = this.selectedElements().find((element): element is Extract<PageElement, { type: "text" }> => element.type === "text"); if (text) this.beginText({ x: text.x, y: text.baseline - text.fontSize, pressure: .5 }, text); });
    byId<HTMLButtonElement>("text-smaller").addEventListener("click", () => this.resizeSelectedText(-2));
    byId<HTMLButtonElement>("text-larger").addEventListener("click", () => this.resizeSelectedText(2));
    byId<HTMLButtonElement>("attach-agent").addEventListener("click", () => this.toggleAgentAttachment());
    byId<HTMLButtonElement>("delete-selection").addEventListener("click", () => this.deleteSelection());
  }

  private bindCanvas(): void {
    this.canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    this.canvas.addEventListener("pointercancel", (event) => this.pointerUp(event));
    this.canvas.addEventListener("pointerleave", () => { this.agentMarkerTip.hidden = true; });
    this.canvas.addEventListener("wheel", (event) => { event.preventDefault(); this.renderer.zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0012)); this.updateZoom(); this.updateContextPrompt(); }, { passive: false });
    this.canvas.addEventListener("dblclick", (event) => {
      if (this.tool !== "select") return; const point = this.renderer.world(event.clientX, event.clientY); const hit = this.renderer.hit(point);
      this.beginText(point, hit?.type === "text" ? hit : undefined);
    });
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 && event.button !== 1) return; event.preventDefault(); this.canvas.setPointerCapture(event.pointerId);
    const point = this.renderer.world(event.clientX, event.clientY); const pan = event.button === 1 || this.spaceDown || this.tool === "hand" || event.pointerType === "touch";
    if (pan) { this.interaction = { mode: "pan", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point }; return; }
    if (this.tool === "select") { this.startSelection(event, point); return; }
    if (this.tool === "pen") {
      this.store.checkpoint(); const stroke: StrokeElement = { type: "stroke", id: uuid("stroke"), color: this.penColor, size: 3, pressureSensitivity: this.store.document.settings.pressure ? 0.7 : 0, points: [{ ...point, pressure: this.store.document.settings.pressure ? event.pressure || 0.5 : 0.5, time: event.timeStamp }] };
      this.store.document.elements.push(stroke); this.interaction = { mode: "draw", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, elementId: stroke.id }; this.renderer.request(); return;
    }
    if (this.tool === "ai-pen") {
      const stroke = [{ ...point, pressure: event.pressure || 0.5, time: event.timeStamp }]; this.renderer.instructionInk.push(stroke); this.interaction = { mode: "instruction", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, instructionIndex: this.renderer.instructionInk.length - 1 }; this.updateContextPrompt(); this.renderer.request(); return;
    }
    if (this.tool === "marker") {
      this.store.checkpoint(); const markerId = uuid("highlight"); this.store.document.elements.push({ type: "highlight", id: markerId, x1: point.x, x2: point.x, y: point.y, size: 28, color: this.penColor === "#080808" ? "#ffd84d" : this.penColor, opacity: Math.min(.42, this.opacity * .32) });
      this.interaction = { mode: "marker", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, markerId }; this.renderer.request(); return;
    }
    if (this.tool === "rectangle" || this.tool === "ellipse" || this.tool === "arrow") {
      this.store.checkpoint(); const shape: ShapeElement = { type: "shape", id: uuid("shape"), kind: this.tool, points: [point, { ...point }], color: this.penColor, size: 3, closed: this.tool !== "arrow", fillColor: "#c0c0c0", fillOpacity: 0, radius: this.tool === "rectangle" ? 14 : undefined };
      this.store.document.elements.push(shape); this.interaction = { mode: "shape", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, elementId: shape.id }; this.renderer.request(); return;
    }
    if (this.tool === "lasso") { this.renderer.lasso = [point]; this.interaction = { mode: "lasso", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, additive: event.shiftKey }; this.renderer.request(); return; }
    if (this.tool === "eraser") { this.interaction = { mode: "erase", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point }; this.erase(point); return; }
    if (this.tool === "text") { this.beginText(point); this.release(event); }
    else if (this.tool === "sticky") { this.beginText(point, undefined, "body", true); this.release(event); }
    else if (this.tool === "table") { this.store.checkpoint(); this.interaction = { mode: "table", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point }; }
    else if (this.tool === "image") this.release(event);
  }

  private startSelection(event: PointerEvent, point: InkPoint): void {
    const selected = this.store.document.elements.filter((element) => this.renderer.selectionIds.has(element.id));
    const handle = selected.length > 0 ? this.renderer.selectionHandleAt(point) : null;
    if (handle) {
      this.interaction = { mode: "resize", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, before: new Map(selected.map((element) => [element.id, structuredClone(element)])), beforeBounds: boardBounds(selected) ?? undefined, handle }; return;
    }
    const hit = this.renderer.hit(point); if (hit?.locked) return;
    if (!hit) { this.renderer.selectionIds.clear(); this.updateContextPrompt(); this.renderer.request(); return; }
    this.updateContextPrompt(); const hitIds = this.store.expandGroupIds([hit.id]);
    if (!event.shiftKey && !hitIds.every((id) => this.renderer.selectionIds.has(id))) this.renderer.selectionIds = new Set(hitIds);
    else if (event.shiftKey) { const remove = hitIds.every((id) => this.renderer.selectionIds.has(id)); hitIds.forEach((id) => remove ? this.renderer.selectionIds.delete(id) : this.renderer.selectionIds.add(id)); }
    const elements = this.store.document.elements.filter((element) => this.renderer.selectionIds.has(element.id));
    this.interaction = { mode: "move", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, before: new Map(elements.map((element) => [element.id, structuredClone(element)])) }; this.updateContextPrompt(); this.renderer.request();
  }

  private pointerMove(event: PointerEvent): void {
    const interaction = this.interaction;
    if (!interaction) { this.updateAgentMarkerHover(event); if (this.tool === "select") this.canvas.style.cursor = this.resizeCursor(this.renderer.selectionHandleAt(this.renderer.world(event.clientX, event.clientY))); return; }
    if (interaction.pointerId !== event.pointerId) return; event.preventDefault();
    const point = this.renderer.world(event.clientX, event.clientY);
    if (interaction.mode === "pan") { this.renderer.camera.x += event.clientX - interaction.startClient.x; this.renderer.camera.y += event.clientY - interaction.startClient.y; interaction.startClient = { x: event.clientX, y: event.clientY }; this.updateContextPrompt(); this.renderer.request(); return; }
    if (interaction.mode === "draw") {
      const stroke = this.store.document.elements.find((element): element is StrokeElement => element.id === interaction.elementId && element.type === "stroke"); if (!stroke) return;
      const samples = event.getCoalescedEvents?.() ?? [event]; for (const sample of samples) { const candidate = this.renderer.world(sample.clientX, sample.clientY); candidate.pressure = this.store.document.settings.pressure ? sample.pressure || 0.5 : 0.5; candidate.time = sample.timeStamp; stroke.points.push(candidate); } this.renderer.request(); return;
    }
    if (interaction.mode === "instruction") {
      const stroke = this.renderer.instructionInk[interaction.instructionIndex ?? -1]; if (!stroke) return; const samples = event.getCoalescedEvents?.() ?? [event]; for (const sample of samples) { const candidate = this.renderer.world(sample.clientX, sample.clientY); candidate.pressure = sample.pressure || 0.5; candidate.time = sample.timeStamp; stroke.push(candidate); } this.renderer.request(); return;
    }
    if (interaction.mode === "marker") { const marker = this.store.document.elements.find((element) => element.id === interaction.markerId); if (marker?.type === "highlight") marker.x2 = point.x; this.renderer.request(); return; }
    if (interaction.mode === "shape") { const shape = this.store.document.elements.find((element): element is ShapeElement => element.id === interaction.elementId && element.type === "shape"); if (shape) { shape.points[1] = point; this.renderer.request(); } return; }
    if (interaction.mode === "table") { this.renderer.lasso = [interaction.startWorld, { x: point.x, y: interaction.startWorld.y, pressure: .5 }, point, { x: interaction.startWorld.x, y: point.y, pressure: .5 }, interaction.startWorld]; this.renderer.request(); return; }
    if (interaction.mode === "lasso") { this.renderer.lasso.push(point); this.renderer.request(); return; }
    if (interaction.mode === "erase") { this.erase(point); return; }
    const dx = point.x - interaction.startWorld.x; const dy = point.y - interaction.startWorld.y;
    if (!interaction.checkpointed && Math.hypot(dx, dy) > 1) { this.store.checkpoint(); interaction.checkpointed = true; }
    if (interaction.mode === "move" && interaction.before) {
      for (const [id, before] of interaction.before) { const index = this.store.document.elements.findIndex((element) => element.id === id); if (index >= 0) { this.store.document.elements[index] = structuredClone(before); translateElement(this.store.document.elements[index], dx, dy); } } this.renderer.request();
    } else if (interaction.mode === "resize" && interaction.before && interaction.beforeBounds && interaction.handle) {
      const from = interaction.beforeBounds; const to = { minX: from.minX, minY: from.minY, maxX: from.maxX, maxY: from.maxY };
      if (interaction.handle.includes("w")) to.minX = Math.min(point.x, to.maxX - 8); if (interaction.handle.includes("e")) to.maxX = Math.max(point.x, to.minX + 8);
      if (interaction.handle.includes("n")) to.minY = Math.min(point.y, to.maxY - 8); if (interaction.handle.includes("s")) to.maxY = Math.max(point.y, to.minY + 8);
      for (const [id, before] of interaction.before) { const index = this.store.document.elements.findIndex((element) => element.id === id); if (index >= 0) { this.store.document.elements[index] = structuredClone(before); scaleElement(this.store.document.elements[index], from, to); } } this.renderer.request();
    }
  }

  private pointerUp(event: PointerEvent): void {
    const interaction = this.interaction; if (!interaction || interaction.pointerId !== event.pointerId) { this.release(event); return; }
    if (interaction.mode === "lasso") {
      const unlocked = this.store.document.elements.filter((element) => !element.locked); const hits = this.store.expandGroupIds(lassoElements(unlocked, this.renderer.lasso)).filter((id) => !this.store.document.elements.find((element) => element.id === id)?.locked);
      this.renderer.selectionIds = interaction.additive ? new Set([...this.renderer.selectionIds, ...hits]) : new Set(hits);
      this.renderer.lasso = []; this.updateContextPrompt(); this.renderer.request();
    } else if (interaction.mode === "draw") {
      const strokeIndex = this.store.document.elements.findIndex((element) => element.id === interaction.elementId);
      const stroke = this.store.document.elements[strokeIndex];
      if (stroke?.type === "stroke") {
        if (this.store.document.settings.inputSmoothing && stroke.points.length > 3) stroke.points = beautifyStroke(stroke.points, .16);
        const optimized = this.store.document.settings.autoShape ? optimizeShape(stroke) : { kind: null };
        if (optimized.kind) this.store.document.elements[strokeIndex] = { type: "shape", id: stroke.id, kind: optimized.kind, points: optimized.stroke!.points, color: stroke.color, size: stroke.size, closed: optimized.kind !== "line" && optimized.kind !== "arrow", fillColor: "#c0c0c0", fillOpacity: 0 };
        else { this.recentHumanStrokeIds.push(stroke.id); this.recentHumanStrokeIds = this.recentHumanStrokeIds.slice(-18); this.scheduleHandwritingAssist(); }
        this.recentHumanEditIds.add(stroke.id);
      }
      this.store.changed();
    } else if (interaction.mode === "instruction") this.updateContextPrompt();
    else if (interaction.mode === "marker") { this.finishMarker(interaction.markerId); this.store.changed(); }
    else if (interaction.mode === "table") {
      const width = Math.max(180, Math.abs(event.clientX - interaction.startClient.x) / this.renderer.camera.zoom); const height = Math.max(120, Math.abs(this.renderer.world(event.clientX, event.clientY).y - interaction.startWorld.y));
      const x = Math.min(interaction.startWorld.x, this.renderer.world(event.clientX, event.clientY).x); const y = Math.min(interaction.startWorld.y, this.renderer.world(event.clientX, event.clientY).y);
      const ids = this.store.applyOperation({ type: "create_table", x, y, width, height, rows: 3, columns: 3, headers: ["", "", ""] }, "human"); ids.forEach((id) => this.recentHumanEditIds.add(id)); this.renderer.lasso = []; this.store.changed();
    }
    else if (interaction.mode === "shape" || interaction.mode === "erase" || interaction.checkpointed) this.store.changed();
    this.interaction = null; this.release(event);
  }

  private resizeCursor(handle: SelectionHandle | null): string {
    if (!handle) return "default"; if (handle === "n" || handle === "s") return "ns-resize"; if (handle === "e" || handle === "w") return "ew-resize";
    return handle === "nw" || handle === "se" ? "nwse-resize" : "nesw-resize";
  }

  private release(event: PointerEvent): void { if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId); }

  private erase(point: InkPoint): void {
    const hit = this.renderer.hit(point, 14); if (!hit || hit.locked) return;
    if (!this.interaction?.checkpointed) { this.store.checkpoint(); if (this.interaction) this.interaction.checkpointed = true; }
    this.store.document.elements = this.store.document.elements.filter((element) => element.id !== hit.id); this.renderer.selectionIds.delete(hit.id); this.renderer.request();
  }

  private finishMarker(markerId?: string): void {
    const marker = this.store.document.elements.find((element) => element.id === markerId); if (marker?.type !== "highlight") return;
    if (Math.abs(marker.x2 - marker.x1) < 4) { this.store.document.elements = this.store.document.elements.filter((element) => element.id !== marker.id); return; }
    if (this.store.document.settings.smartHighlight) {
      const minX = Math.min(marker.x1, marker.x2); const maxX = Math.max(marker.x1, marker.x2); const radius = marker.size * .85;
      const boxes = this.store.document.elements.filter((element) => element.type === "text" || element.type === "stroke").map((element) => ({ element, bounds: boardBounds([element])! })).filter(({ bounds }) => bounds.maxX >= minX && bounds.minX <= maxX && bounds.maxY >= marker.y - radius && bounds.minY <= marker.y + radius);
      if (boxes.length) { marker.x1 = Math.min(...boxes.map(({ bounds }) => bounds.minX)) - 7; marker.x2 = Math.max(...boxes.map(({ bounds }) => bounds.maxX)) + 7; marker.y = boxes.reduce((sum, { bounds }) => sum + (bounds.minY + bounds.maxY) / 2, 0) / boxes.length; marker.size = Math.max(18, Math.min(42, Math.max(...boxes.map(({ bounds }) => bounds.maxY - bounds.minY)) * .72)); }
    }
    this.recentHumanEditIds.add(marker.id);
  }

  private scheduleHandwritingAssist(): void {
    window.clearTimeout(this.handwritingTimer); if (!this.store.document.settings.englishHandwritingAssist) return;
    this.handwritingTimer = window.setTimeout(() => void this.recognizeRecentHandwriting(), 720);
  }

  private async recognizeRecentHandwriting(): Promise<void> {
    if (!this.store.document.settings.englishHandwritingAssist) return;
    const ids = [...this.recentHumanStrokeIds]; const strokes = ids.map((id) => this.store.document.elements.find((element) => element.id === id)).filter((element): element is StrokeElement => element?.type === "stroke");
    if (!strokes.length) return; const currentSignatures = strokes.map((stroke) => `${stroke.id}:${stroke.points.length}:${stroke.points.at(-1)?.x}:${stroke.points.at(-1)?.y}`);
    const text = await this.handwriting.recognize(strokes); if (!text || !this.store.document.settings.englishHandwritingAssist) return;
    const stillCurrent = strokes.every((stroke, index) => { const current = this.store.document.elements.find((element) => element.id === stroke.id); return current?.type === "stroke" && `${current.id}:${current.points.length}:${current.points.at(-1)?.x}:${current.points.at(-1)?.y}` === currentSignatures[index]; });
    if (!stillCurrent) return; strokes.forEach((stroke) => { const current = this.store.document.elements.find((element) => element.id === stroke.id); if (current?.type === "stroke") current.recognitionText = text; }); this.store.changed();
  }

  private beginText(point: InkPoint, existing?: Extract<PageElement, { type: "text" }>, initialStyle: Extract<PageElement, { type: "text" }>["blockStyle"] = "body", sticky = false): void {
    const shell = document.createElement("div"); shell.className = "text-editor-shell"; const controls = document.createElement("div"); controls.className = "text-controls";
    const style = document.createElement("select"); style.setAttribute("aria-label", "Textstil"); for (const [value, label] of [["body", "Text"], ["heading-1", "Titel"], ["heading-2", "Überschrift"], ["bullet", "Stichpunkte"], ["numbered", "Nummeriert"], ["check", "Checkliste"], ["quote", "Zitat"], ["code", "Code"], ["math", "Mathe"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; style.appendChild(option); } style.value = existing?.blockStyle ?? initialStyle;
    const input = document.createElement("textarea"); input.setAttribute("aria-label", "Text auf dem Whiteboard"); input.rows = 2; controls.append(style); shell.append(controls, input);
    const anchor = existing ? { x: existing.x, y: existing.baseline - existing.fontSize } : point;
    const screen = this.renderer.screen(anchor); const rect = this.canvas.getBoundingClientRect(); shell.style.left = `${rect.left + screen.x}px`; shell.style.top = `${rect.top + screen.y}px`; input.value = existing?.text ?? ""; document.body.appendChild(shell); input.focus(); input.select();
    shell.style.width = `${Math.max(220, (existing?.width ?? (sticky ? 320 : 260)) * this.renderer.camera.zoom)}px`; shell.style.height = `${Math.max(126, (existing?.height ?? (sticky ? 190 : 94)) * this.renderer.camera.zoom + 41)}px`;
    let committed = false; const commit = (): void => { if (committed || !shell.isConnected) return; committed = true; const text = input.value.trim(); const editorRect = shell.getBoundingClientRect(); shell.remove(); if (!text) return; this.store.checkpoint();
      const width = Math.max(80, editorRect.width / this.renderer.camera.zoom); const height = Math.max(40, editorRect.height / this.renderer.camera.zoom);
      if (existing) { const current = this.store.document.elements.find((element) => element.id === existing.id); if (current?.type === "text") { current.text = text; current.width = width; current.blockStyle = style.value as typeof current.blockStyle; current.height = Math.max(height - 41, estimateTextHeight(text, width, current.fontSize)); this.recentHumanEditIds.add(current.id); } }
      else if (sticky) { const ids = this.store.applyOperation({ type: "create_note", x: point.x, y: point.y, width, height: Math.max(100, height - 41), text, color: this.penColor, blockStyle: style.value as Extract<PageElement, { type: "text" }>["blockStyle"] }, "human"); ids.forEach((id) => this.recentHumanEditIds.add(id)); }
      else { const fontSize = style.value === "heading-1" ? 48 : style.value === "heading-2" ? 38 : 30; const element = { type: "text", id: uuid("text"), x: point.x, baseline: point.y + fontSize, width, height: Math.max(height - 41, estimateTextHeight(text, width, fontSize)), fontSize, color: this.penColor, text, blockStyle: style.value as Extract<PageElement, { type: "text" }>["blockStyle"], semanticRole: "text-field" } as const; this.store.document.elements.push(element); this.recentHumanEditIds.add(element.id); }
      this.store.changed(); };
    shell.addEventListener("focusout", (event) => { if (!shell.contains(event.relatedTarget as Node | null)) commit(); }); input.addEventListener("keydown", (event) => { if (event.key === "Escape") { input.value = ""; commit(); } if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commit(); this.submitHumanTurn(); } });
  }

  private bindKeyboard(): void {
    window.addEventListener("keydown", (event) => {
      const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); this.submitHumanTurn(); return; } if (editing) return;
      if (event.code === "Space") { event.preventDefault(); this.spaceDown = true; this.canvas.classList.add("is-panning"); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? this.store.redo() : this.store.undo(); }
      if ((event.key === "Delete" || event.key === "Backspace") && this.renderer.selectionIds.size) { event.preventDefault(); this.deleteSelection(); }
      const shortcuts: Partial<Record<string, BoardTool>> = { v: "select", h: "hand", p: "pen", i: "ai-pen", m: "marker", n: "sticky", r: "rectangle", o: "ellipse", a: "arrow", t: "text", l: "lasso", e: "eraser" };
      const shortcut = shortcuts[event.key.toLowerCase()]; if (shortcut && !event.ctrlKey && !event.metaKey) this.setTool(shortcut);
    });
    window.addEventListener("keyup", (event) => { if (event.code === "Space") { this.spaceDown = false; this.canvas.classList.remove("is-panning"); } });
  }

  private bindCollaboration(): void {
    byId<HTMLButtonElement>("accept").innerHTML = `${icon("check")}<span>Accept</span>`; byId<HTMLButtonElement>("undo-agent").innerHTML = `${icon("close")}<span>Undo</span>`;
    byId<HTMLButtonElement>("submit-turn").addEventListener("click", () => this.submitHumanTurn());
    byId<HTMLButtonElement>("accept").addEventListener("click", () => { this.store.acceptAgentContribution(); this.renderer.activeAgentIds.clear(); this.renderer.instructionInk = []; this.agentMarkerTip.hidden = true; this.setStatus("Agentenbeitrag übernommen", 1800); });
    byId<HTMLButtonElement>("undo-agent").addEventListener("click", () => { if (this.store.undoAgentContribution()) { this.renderer.activeAgentIds.clear(); this.renderer.instructionInk = []; this.agentMarkerTip.hidden = true; this.setStatus("Agentenbeitrag zurückgenommen", 1800); } });
  }

  private bindSettings(): void {
    const pairs = [["setting-smoothing", "inputSmoothing"], ["setting-pressure", "pressure"], ["setting-auto-shape", "autoShape"], ["setting-smart-highlight", "smartHighlight"], ["setting-english-assist", "englishHandwritingAssist"]] as const;
    for (const [id, key] of pairs) { const input = byId<HTMLInputElement>(id); input.checked = this.store.document.settings[key]; input.addEventListener("change", () => { this.store.document.settings[key] = input.checked; if (key === "englishHandwritingAssist" && !input.checked) { window.clearTimeout(this.handwritingTimer); this.store.document.elements.forEach((element) => { if (element.type === "stroke") delete element.recognitionText; }); } this.store.changed(); }); }
    const native = byId<HTMLInputElement>("color-native"); const hex = byId<HTMLInputElement>("color-hex"); const opacity = byId<HTMLInputElement>("color-opacity"); const apply = (value: string) => { if (!/^#[0-9a-f]{6}$/i.test(value)) return; this.penColor = value.toLowerCase(); native.value = this.penColor; hex.value = this.penColor; document.querySelectorAll("[data-color]").forEach((item) => item.classList.remove("is-active")); if (this.renderer.selectionIds.size) { this.store.checkpoint(); this.store.applyOperation({ type: "update_style", ids: [...this.renderer.selectionIds], color: this.penColor, opacity: this.opacity }, "human"); this.store.changed(); } };
    native.addEventListener("input", () => apply(native.value)); hex.addEventListener("change", () => apply(hex.value)); opacity.addEventListener("input", () => { this.opacity = Number(opacity.value) / 100; });
    byId<HTMLElement>("handwriting-support").textContent = this.handwriting.supported() ? "Lokale englische Erkennung des Betriebssystems verfügbar; sichtbare Tinte bleibt unverändert." : "Keine lokale OS-Erkennung verfügbar; nur sanfte geometrische Glättung wird verwendet.";
  }

  private bindFiles(): void {
    this.imageInput.addEventListener("change", () => { const file = this.imageInput.files?.[0]; this.imageInput.value = ""; if (!file) return;
      const reader = new FileReader(); reader.onload = () => { const dataUrl = String(reader.result); const image = new Image(); image.onload = () => { const centre = this.renderer.world(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2); const scale = Math.min(1, 560 / image.naturalWidth);
        const element: ImageElement = { type: "image", id: uuid("image"), x: centre.x - image.naturalWidth * scale / 2, y: centre.y - image.naturalHeight * scale / 2, width: image.naturalWidth * scale, height: image.naturalHeight * scale, dataUrl, mimeType: file.type === "image/png" ? "image/png" : "image/jpeg", sourceName: file.name };
        this.store.checkpoint(); this.store.document.elements.push(element); this.store.changed(); }; image.src = dataUrl; }; reader.readAsDataURL(file);
    });
    byId<HTMLButtonElement>("export-json").addEventListener("click", () => { const blob = new Blob([JSON.stringify(this.store.document, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "shared-whiteboard.json"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); });
    const importInput = byId<HTMLInputElement>("import-json"); importInput.addEventListener("change", () => { const file = importInput.files?.[0]; importInput.value = ""; if (!file) return; void file.text().then((text) => { const parsed = migrateBoard(JSON.parse(text) as unknown); if (!parsed) throw new Error("Ungültiges Whiteboard"); this.store.checkpoint(); this.store.replace(parsed); this.renderer.fitAll(); }).catch(() => this.setStatus("Datei konnte nicht geöffnet werden", 2200)); });
  }

  private inspect(scope: "all" | "priority" | "selection"): Record<string, unknown> {
    const turn = this.store.document.turn; const priorityIds = turn?.priorityRegions.flatMap((region) => region.elementIds) ?? []; const ids = scope === "selection" ? (turn?.selectionIds.length ? turn.selectionIds : [...this.renderer.selectionIds]) : scope === "priority" ? priorityIds : null;
    const elements = ids ? this.store.document.elements.filter((element) => ids.includes(element.id)) : this.store.document.elements;
    return { revision: this.store.document.revision, coordinateSystem: "Infinite 2D world coordinates; +x right, +y down", viewport: { ...this.renderer.camera, width: this.canvas.clientWidth, height: this.canvas.clientHeight }, turn, priorityRegions: turn?.priorityRegions ?? [], selectionBounds: boardBounds(elements), settings: this.store.document.settings, elements: elements.map((element) => { const summary = elementSummary(element); if (element.type === "stroke" && !this.store.document.settings.englishHandwritingAssist) delete (summary as Record<string, unknown>).recognitionText; return { ...summary, groupId: this.store.groupIdFor(element.id) ?? null }; }) };
  }

  private async applyAgentOperations(operations: CanvasOperation[], baseRevision?: number, maxOperations = 120, delay = 65, leaseToken?: string): Promise<Record<string, unknown>> {
    const leaseError = this.validateLease(leaseToken); if (leaseError) return leaseError;
    if (!Array.isArray(operations) || operations.length === 0) return { ok: false, error: "No operations supplied" };
    if (operations.length > maxOperations || operations.some((operation) => !isCanvasOperation(operation))) return { ok: false, error: "invalid_operations", instruction: `Use the operation schema exactly, keep coordinates finite, and stay below ${maxOperations} operations.` };
    if (baseRevision !== undefined && baseRevision !== this.store.document.revision) return { ok: false, error: "stale_revision", currentRevision: this.store.document.revision, instruction: "Inspect the whiteboard again before editing." };
    const createsElement = new Set(["create_text", "create_note", "create_table", "create_frame", "create_highlight", "create_shape", "create_arrow", "create_stroke", "create_polygon", "connect"]); const explicitIds = operations.filter((operation) => createsElement.has(operation.type) && "id" in operation && typeof operation.id === "string").map((operation) => (operation as { id: string }).id); const existing = new Set(this.store.document.elements.map((element) => element.id));
    if (new Set(explicitIds).size !== explicitIds.length || explicitIds.some((id) => existing.has(id))) return { ok: false, error: "id_conflict", instruction: "Use unique IDs that are not already present on the board; inspect again if needed." };
    this.store.beginAgentContribution(); this.updateUi(); this.setStatus("Agent arbeitet auf dem Canvas …"); const created: string[] = [];
    for (const operation of operations.slice(0, maxOperations)) { const targetIds = this.store.expandGroupIds(operationTargetIds(operation)); const ids = this.store.applyOperation(operation, "agent"); created.push(...ids); this.renderer.activeAgentIds = new Set([...this.renderer.activeAgentIds, ...ids, ...targetIds]); this.store.changed(); await new Promise((resolve) => setTimeout(resolve, delay)); }
    return { ok: true, revision: this.store.document.revision, createdIds: created, message: "Changes are visible and editable. Call complete_whiteboard_contribution with the same lease." };
  }

  private async composeAgentVisual(input: VisualCompositionInput, baseRevision?: number, leaseToken?: string): Promise<Record<string, unknown>> {
    if (!isVisualComposition(input)) return { ok: false, error: "invalid_visual", instruction: "Use one supported visual kind and provide valid nodes, sections, steps, axes or series." };
    const operations = composeVisual(input); if (!operations.length) return { ok: false, error: "empty_visual" };
    return this.applyAgentOperations(operations, baseRevision, 240, 35, leaseToken);
  }

  private completeAgent(summary: string, leaseToken?: string): Record<string, unknown> {
    const leaseError = this.validateLease(leaseToken); if (leaseError) return leaseError;
    if (this.store.document.turn) { this.store.document.turn.status = "complete"; this.store.document.turn.instructionInk = []; } this.renderer.instructionInk = []; this.renderer.request(); this.store.changed(); this.setStatus(summary, 4000); return { ok: true, revision: this.store.document.revision, awaitingHumanDecision: true, instruction: "Call wait_for_human_turn to continue the alternating session." };
  }

  private session(): Record<string, unknown> {
    const turn = this.store.document.turn; return turn?.status === "queued" ? this.claimTurn(turn) : { ok: true, state: turn?.status ?? "idle", revision: this.store.document.revision, instruction: "Call wait_for_human_turn and wait for the human submit arrow." };
  }

  private waitForTurn(timeoutMs: number): Promise<Record<string, unknown>> {
    const turn = this.store.document.turn; if (turn?.status === "queued") return Promise.resolve(this.claimTurn(turn));
    return new Promise((resolve) => { let settled = false; const finish = (value: Record<string, unknown>) => { if (settled) return; settled = true; resolve(value); }; this.turnWaiters.push(finish); window.setTimeout(() => { this.turnWaiters = this.turnWaiters.filter((candidate) => candidate !== finish); finish({ ok: true, state: "waiting", revision: this.store.document.revision, instruction: "No human turn yet. Call wait_for_human_turn again." }); }, timeoutMs); });
  }

  private claimTurn(turn: CollaborationTurn): Record<string, unknown> {
    if (!turn.leaseToken) turn.leaseToken = crypto.randomUUID(); turn.status = "claimed"; this.store.changed(); this.updateUi();
    return { ok: true, state: "claimed", leaseToken: turn.leaseToken, turnId: turn.id, revision: this.store.document.revision, priorityRegions: turn.priorityRegions, selectionIds: turn.selectionIds, instructionInk: turn.instructionInk, changedElementIds: turn.changedElementIds, instruction: "Inspect priority scope, publish one concise plan, edit with this lease, complete, then wait again." };
  }

  private submitHumanTurn(): void {
    if (this.store.document.turn && ["queued", "claimed", "planning", "working"].includes(this.store.document.turn.status)) { this.setStatus(this.store.document.turn.status === "queued" ? "Die Notiz wartet bereits auf den Agenten" : "Der Agent bearbeitet noch den aktuellen Turn", 2200); return; }
    const ink = structuredClone(this.renderer.instructionInk); const selectionIds = [...this.renderer.selectionIds]; const priorityRegions: PriorityRegion[] = [];
    const inkPoints = ink.flat(); if (inkPoints.length) priorityRegions.push({ source: "ai-pen", bounds: this.boundsForPoints(inkPoints), elementIds: [], priority: 100 });
    const attached = this.store.document.elements.filter((element) => element.agentAttached); const attachedIds = attached.map((element) => element.id); const attachedBounds = boardBounds(attached); if (attachedBounds) priorityRegions.push({ source: "attachment", bounds: attachedBounds, elementIds: attachedIds, priority: 90 });
    const selected = this.store.document.elements.filter((element) => selectionIds.includes(element.id)); const selectionBounds = boardBounds(selected); if (selectionBounds) priorityRegions.push({ source: "selection", bounds: selectionBounds, elementIds: selectionIds, priority: 80 });
    const highlights = this.store.document.elements.filter((element) => element.type === "highlight").slice(-8); for (const highlight of highlights) priorityRegions.push({ source: "highlight", bounds: boardBounds([highlight])!, elementIds: [highlight.id], priority: 60 });
    const changedElementIds = [...this.recentHumanEditIds].filter((id) => this.store.document.elements.some((element) => element.id === id)); const changedBounds = boardBounds(this.store.document.elements.filter((element) => changedElementIds.includes(element.id))); if (changedBounds) priorityRegions.push({ source: "recent-edit", bounds: changedBounds, elementIds: changedElementIds, priority: 40 });
    this.store.checkpoint(); const turn: CollaborationTurn = { id: uuid("turn"), status: "queued", submittedRevision: this.store.document.revision, createdAt: new Date().toISOString(), selectionIds, instructionInk: ink, priorityRegions: priorityRegions.sort((a, b) => b.priority - a.priority), changedElementIds }; this.store.document.turn = turn; attached.forEach((element) => { element.agentAttached = false; }); this.store.changed(); this.recentHumanEditIds.clear();
    const waiting = this.turnWaiters.splice(0); if (waiting.length) { const claimed = this.claimTurn(turn); waiting.forEach((resolve) => resolve(claimed)); }
    this.setStatus(ink.length ? "Blaue Anweisung und Notiz übergeben" : "Notiz an den Agenten übergeben", 2400); this.updateUi();
  }

  private boundsForPoints(points: InkPoint[]): PriorityRegion["bounds"] { return { minX: Math.min(...points.map((point) => point.x)), minY: Math.min(...points.map((point) => point.y)), maxX: Math.max(...points.map((point) => point.x)), maxY: Math.max(...points.map((point) => point.y)) }; }

  private validateLease(leaseToken?: string): Record<string, unknown> | null {
    const turn = this.store.document.turn; if (!turn || !["claimed", "planning", "working"].includes(turn.status)) return { ok: false, error: "no_claimed_turn", instruction: "Call wait_for_human_turn first." };
    return leaseToken && leaseToken === turn.leaseToken ? null : { ok: false, error: "invalid_lease", instruction: "Use the leaseToken returned by wait_for_human_turn." };
  }

  private publishPlan(summary: string, leaseToken?: string): Record<string, unknown> {
    const leaseError = this.validateLease(leaseToken); if (leaseError) return leaseError; if (!summary.trim()) return { ok: false, error: "empty_plan" };
    const turn = this.store.document.turn!; turn.planSummary = summary.trim().slice(0, 240); turn.status = "planning"; this.store.changed(); this.setStatus(turn.planSummary); return { ok: true, revision: this.store.document.revision };
  }

  private focus(bounds: PriorityRegion["bounds"]): Record<string, unknown> { this.renderer.fitBounds(bounds); this.updateContextPrompt(); return { ok: true, viewport: { ...this.renderer.camera } }; }

  private clearBoard(): void { if (this.store.document.elements.length === 0 || !window.confirm("Gesamtes Whiteboard leeren?")) return; this.renderer.selectionIds.clear(); this.store.clear(); }
  private selectedElements(): PageElement[] { return this.store.document.elements.filter((element) => this.renderer.selectionIds.has(element.id)); }
  private duplicateSelection(): void {
    const selected = this.selectedElements(); if (!selected.length) return; this.store.checkpoint(); const created = this.store.applyOperation({ type: "duplicate", ids: selected.map((element) => element.id), dx: 24, dy: 24 }, "human");
    this.renderer.selectionIds = new Set(created); this.store.changed();
  }
  private reorderSelection(direction: "front" | "back"): void { const ids = [...this.renderer.selectionIds]; if (!ids.length) return; this.store.checkpoint(); this.store.applyOperation({ type: "reorder", ids, direction }, "human"); this.store.changed(); }
  private resizeSelectedText(delta: number): void {
    const texts = this.selectedElements().filter((element): element is Extract<PageElement, { type: "text" }> => element.type === "text"); if (!texts.length) return; this.store.checkpoint();
    for (const text of texts) { text.fontSize = Math.max(10, Math.min(180, text.fontSize + delta)); text.height = estimateTextHeight(text.text, text.width, text.fontSize); } this.store.changed();
  }
  private deleteSelection(): void {
    const ids = [...this.renderer.selectionIds]; if (!ids.length) return; this.store.checkpoint(); this.store.applyOperation({ type: "delete", ids }, "human"); this.renderer.selectionIds.clear(); this.store.changed();
  }
  private toggleAgentAttachment(): void {
    const ids = this.store.expandGroupIds([...this.renderer.selectionIds]); const elements = this.store.document.elements.filter((element) => ids.includes(element.id)); if (!elements.some((element) => element.semanticRole === "note" || element.semanticRole === "note-body")) return;
    const attached = elements.some((element) => element.agentAttached); this.store.checkpoint(); elements.forEach((element) => { element.agentAttached = !attached; }); this.store.changed(); this.setStatus(attached ? "Notizzettel nicht mehr vorgemerkt" : "Notizzettel wird beim nächsten Submit angehängt", 2200);
  }
  private setStatus(text: string, duration = 0): void { this.status.textContent = text; if (duration) setTimeout(() => { if (this.status.textContent === text) this.status.textContent = ""; }, duration); }
  private updateUi(): void { this.review.hidden = !this.store.hasAgentContribution(); byId<HTMLSpanElement>("revision").textContent = `r${this.store.document.revision}`; const submit = byId<HTMLButtonElement>("submit-turn"); const busy = Boolean(this.store.document.turn && ["queued", "claimed", "planning", "working"].includes(this.store.document.turn.status)); submit.classList.toggle("is-waiting", busy); submit.disabled = busy; this.updateZoom(); this.updateContextPrompt(); }
  private updateZoom(): void { byId<HTMLSpanElement>("zoom").textContent = `${Math.round(this.renderer.camera.zoom * 100)}%`; }
  private updateContextPrompt(): void {
    const tools = byId<HTMLElement>("selection-tools"); const bounds = this.renderer.selectionBounds(); tools.hidden = !bounds;
    const count = this.store.selectionUnitCount([...this.renderer.selectionIds]); const ink = this.renderer.instructionInk.length; byId<HTMLElement>("request-scope").textContent = ink && count ? `AI-Pen + ${count} Auswahl` : ink ? "AI-Pen-Anweisung" : count ? `${count} Auswahl` : "Gesamte Notiz";
    if (!bounds) return;
    const top = this.renderer.screen({ x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY });
    tools.style.left = `${Math.max(170, Math.min(window.innerWidth - 170, top.x))}px`; tools.style.top = `${Math.max(72, top.y - 54)}px`;
    const selected = this.selectedElements(); tools.classList.toggle("has-text", selected.some((element) => element.type === "text")); tools.classList.toggle("has-note", selected.some((element) => element.semanticRole === "note" || element.semanticRole === "note-body")); byId<HTMLButtonElement>("attach-agent").classList.toggle("is-active", selected.some((element) => element.agentAttached));
  }

  private updateAgentMarkerHover(event: PointerEvent): void {
    const hit = this.renderer.hit(this.renderer.world(event.clientX, event.clientY), 12);
    if (!hit || !this.renderer.activeAgentIds.has(hit.id)) { this.agentMarkerTip.hidden = true; return; }
    this.agentMarkerTip.hidden = false; this.agentMarkerTip.style.left = `${Math.min(window.innerWidth - 190, event.clientX + 16)}px`; this.agentMarkerTip.style.top = `${Math.max(76, event.clientY - 18)}px`;
  }
}

new WhiteboardApp();
