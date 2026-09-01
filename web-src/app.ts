import { ImageElement, PageElement, ShapeElement, StrokeElement } from "../src/document";
import { InkPoint } from "../src/strokes";
import { optimizeShape } from "../src/shapes";
import { BoardRenderer, SelectionHandle } from "./renderer";
import { BoardStore } from "./store";
import { BoardTool, CanvasOperation, boardBounds, elementSummary, estimateTextHeight, isCanvasOperation, lassoElements, scaleElement, translateElement, validBoard } from "./model";
import { VisualCompositionInput, composeVisual, isVisualComposition } from "./compositions";
import { registerWhiteboardTools } from "./webmcp";

const icons: Record<string, string> = {
  select: '<path d="M5 3l14 9-7 2-3 7z"/><path d="M13 14l5 5"/>', hand: '<path d="M8 11V7a2 2 0 014 0v3-5a2 2 0 014 0v5-3a2 2 0 014 0v4-2a2 2 0 014 0v5c0 5-3 7-7 7h-1c-3 0-5-2-7-5l-2-3a2 2 0 013-2l2 2"/>',
  pen: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 7l3 3"/>', rectangle: '<rect x="4" y="5" width="16" height="14" rx="1"/>', ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>', arrow: '<path d="M4 12h15M14 7l5 5-5 5"/>',
  "ai-pen": '<path d="M4 20l4-1 10-10-3-3L5 16z"/><path d="M18 3v4M16 5h4M20 11v3M18.5 12.5h3"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M8 20h8"/>', image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="M4 17l5-5 4 4 2-2 5 4"/>', lasso: '<path d="M19 8c0-3-3-5-7-5S4 5 4 9s4 6 9 6c4 0 7-2 7-5M13 15c0 4-2 6-5 6-2 0-3-1-3-2s1-2 3-2c2 0 4 2 5 4"/>',
  eraser: '<path d="M7 19h12M4 14l8-9a2 2 0 013 0l4 4a2 2 0 010 3l-7 7H8l-4-3a2 2 0 010-2z"/>', undo: '<path d="M9 7l-5 5 5 5"/><path d="M5 12h8a6 6 0 016 6"/>', redo: '<path d="M15 7l5 5-5 5"/><path d="M19 12h-8a6 6 0 00-6 6"/>',
  fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>', trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>', check: '<path d="M5 12l4 4 10-10"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>',
  send: '<path d="M3 12h9M12 7v10M14 7l7 5-7 5z"/>', copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 00-2-2H5a2 2 0 00-2 2v9a2 2 0 002 2h3"/>',
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
  mode: "pan" | "draw" | "instruction" | "shape" | "lasso" | "move" | "resize" | "erase";
  pointerId: number; startClient: { x: number; y: number }; startWorld: InkPoint; elementId?: string;
  before?: Map<string, PageElement>; beforeBounds?: { minX: number; minY: number; maxX: number; maxY: number }; checkpointed?: boolean;
  additive?: boolean;
  handle?: SelectionHandle;
  instructionIndex?: number;
}

export class WhiteboardApp {
  private readonly store = new BoardStore();
  private readonly canvas = byId<HTMLCanvasElement>("board");
  private readonly renderer = new BoardRenderer(this.canvas, () => this.store.document.elements, () => new Set(Object.values(this.store.document.connections ?? {}).map((connection) => connection.labelId).filter((id): id is string => Boolean(id))));
  private tool: BoardTool = "pen";
  private penColor = "#080808";
  private interaction: Interaction | null = null;
  private spaceDown = false;
  private readonly status = byId<HTMLSpanElement>("status");
  private readonly requestForm = byId<HTMLFormElement>("agent-form");
  private readonly instruction = byId<HTMLInputElement>("instruction");
  private readonly review = byId<HTMLDivElement>("review");
  private readonly agentMarkerTip = byId<HTMLDivElement>("agent-marker-tip");
  private readonly imageInput = byId<HTMLInputElement>("image-input");
  private readonly abort = new AbortController();

  constructor() {
    this.renderer.instructionInk = structuredClone(this.store.document.request?.ink ?? []);
    this.bindToolbar(); this.bindSelectionTools(); this.bindCanvas(); this.bindKeyboard(); this.bindCollaboration(); this.bindFiles();
    this.store.addEventListener("change", () => { this.renderer.request(); this.updateUi(); });
    this.renderer.request(); this.updateUi();
    void registerWhiteboardTools({ inspect: (scope) => this.inspect(scope), apply: (operations, revision) => this.applyAgentOperations(operations, revision), compose: (input, revision) => this.composeAgentVisual(input, revision), complete: (summary) => this.completeAgent(summary) }, this.abort.signal)
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
      document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((candidate) => candidate.classList.toggle("is-active", candidate === button));
    }));
    this.setTool("pen");
  }

  private setTool(tool: BoardTool): void {
    this.tool = tool; this.canvas.dataset.tool = tool; this.canvas.style.cursor = "";
    document.querySelectorAll<HTMLButtonElement>("button[data-tool]").forEach((button) => button.classList.toggle("is-active", button.dataset.tool === tool));
  }

  private bindSelectionTools(): void {
    for (const [id, name] of [["duplicate", "copy"], ["send-back", "back"], ["bring-front", "front"], ["text-smaller", "minus"], ["text-larger", "plus"], ["delete-selection", "trash"]] as const) byId<HTMLButtonElement>(id).innerHTML = icon(name);
    byId<HTMLButtonElement>("duplicate").addEventListener("click", () => this.duplicateSelection());
    byId<HTMLButtonElement>("send-back").addEventListener("click", () => this.reorderSelection("back"));
    byId<HTMLButtonElement>("bring-front").addEventListener("click", () => this.reorderSelection("front"));
    byId<HTMLButtonElement>("text-smaller").addEventListener("click", () => this.resizeSelectedText(-2));
    byId<HTMLButtonElement>("text-larger").addEventListener("click", () => this.resizeSelectedText(2));
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
      this.store.checkpoint(); const stroke: StrokeElement = { type: "stroke", id: uuid("stroke"), color: this.penColor, size: 3, pressureSensitivity: 0.7, points: [{ ...point, pressure: event.pressure || 0.5, time: event.timeStamp }] };
      this.store.document.elements.push(stroke); this.interaction = { mode: "draw", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, elementId: stroke.id }; this.renderer.request(); return;
    }
    if (this.tool === "ai-pen") {
      const stroke = [{ ...point, pressure: event.pressure || 0.5, time: event.timeStamp }]; this.renderer.instructionInk.push(stroke); this.interaction = { mode: "instruction", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, instructionIndex: this.renderer.instructionInk.length - 1 }; this.updateContextPrompt(); this.renderer.request(); return;
    }
    if (this.tool === "rectangle" || this.tool === "ellipse" || this.tool === "arrow") {
      this.store.checkpoint(); const shape: ShapeElement = { type: "shape", id: uuid("shape"), kind: this.tool, points: [point, { ...point }], color: this.penColor, size: 3, closed: this.tool !== "arrow", fillColor: "#c0c0c0", fillOpacity: 0, radius: this.tool === "rectangle" ? 14 : undefined };
      this.store.document.elements.push(shape); this.interaction = { mode: "shape", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, elementId: shape.id }; this.renderer.request(); return;
    }
    if (this.tool === "lasso") { this.renderer.lasso = [point]; this.interaction = { mode: "lasso", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, additive: event.shiftKey }; this.renderer.request(); return; }
    if (this.tool === "eraser") { this.interaction = { mode: "erase", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point }; this.erase(point); return; }
    if (this.tool === "text") { this.beginText(point); this.release(event); }
    else if (this.tool === "image") this.release(event);
  }

  private startSelection(event: PointerEvent, point: InkPoint): void {
    const selected = this.store.document.elements.filter((element) => this.renderer.selectionIds.has(element.id));
    const handle = selected.length > 0 ? this.renderer.selectionHandleAt(point) : null;
    if (handle) {
      this.interaction = { mode: "resize", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, before: new Map(selected.map((element) => [element.id, structuredClone(element)])), beforeBounds: boardBounds(selected) ?? undefined, handle }; return;
    }
    const hit = this.renderer.hit(point);
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
      const samples = event.getCoalescedEvents?.() ?? [event]; for (const sample of samples) { const candidate = this.renderer.world(sample.clientX, sample.clientY); candidate.pressure = sample.pressure || 0.5; candidate.time = sample.timeStamp; stroke.points.push(candidate); } this.renderer.request(); return;
    }
    if (interaction.mode === "instruction") {
      const stroke = this.renderer.instructionInk[interaction.instructionIndex ?? -1]; if (!stroke) return; const samples = event.getCoalescedEvents?.() ?? [event]; for (const sample of samples) { const candidate = this.renderer.world(sample.clientX, sample.clientY); candidate.pressure = sample.pressure || 0.5; candidate.time = sample.timeStamp; stroke.push(candidate); } this.renderer.request(); return;
    }
    if (interaction.mode === "shape") { const shape = this.store.document.elements.find((element): element is ShapeElement => element.id === interaction.elementId && element.type === "shape"); if (shape) { shape.points[1] = point; this.renderer.request(); } return; }
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
      const hits = this.store.expandGroupIds(lassoElements(this.store.document.elements, this.renderer.lasso));
      this.renderer.selectionIds = interaction.additive ? new Set([...this.renderer.selectionIds, ...hits]) : new Set(hits);
      this.renderer.lasso = []; this.updateContextPrompt(); this.renderer.request();
    } else if (interaction.mode === "draw") {
      const strokeIndex = this.store.document.elements.findIndex((element) => element.id === interaction.elementId);
      const stroke = this.store.document.elements[strokeIndex];
      if (stroke?.type === "stroke") {
        const optimized = optimizeShape(stroke);
        if (optimized.kind) this.store.document.elements[strokeIndex] = { type: "shape", id: stroke.id, kind: optimized.kind, points: optimized.stroke.points, color: stroke.color, size: stroke.size, closed: optimized.kind !== "line" && optimized.kind !== "arrow", fillColor: "#c0c0c0", fillOpacity: 0 };
      }
      this.store.changed();
    } else if (interaction.mode === "instruction") this.updateContextPrompt();
    else if (interaction.mode === "shape" || interaction.mode === "erase" || interaction.checkpointed) this.store.changed();
    this.interaction = null; this.release(event);
  }

  private resizeCursor(handle: SelectionHandle | null): string {
    if (!handle) return "default"; if (handle === "n" || handle === "s") return "ns-resize"; if (handle === "e" || handle === "w") return "ew-resize";
    return handle === "nw" || handle === "se" ? "nwse-resize" : "nesw-resize";
  }

  private release(event: PointerEvent): void { if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId); }

  private erase(point: InkPoint): void {
    const hit = this.renderer.hit(point, 14); if (!hit) return;
    if (!this.interaction?.checkpointed) { this.store.checkpoint(); if (this.interaction) this.interaction.checkpointed = true; }
    this.store.document.elements = this.store.document.elements.filter((element) => element.id !== hit.id); this.renderer.selectionIds.delete(hit.id); this.renderer.request();
  }

  private beginText(point: InkPoint, existing?: Extract<PageElement, { type: "text" }>): void {
    const input = document.createElement("textarea"); input.className = "text-editor"; input.setAttribute("aria-label", "Text auf dem Whiteboard"); input.rows = 1;
    const anchor = existing ? { x: existing.x, y: existing.baseline - existing.fontSize } : point;
    const screen = this.renderer.screen(anchor); const rect = this.canvas.getBoundingClientRect(); input.style.left = `${rect.left + screen.x}px`; input.style.top = `${rect.top + screen.y}px`; input.value = existing?.text ?? ""; document.body.appendChild(input); input.focus(); input.select();
    input.style.width = `${Math.max(180, (existing?.width ?? 240) * this.renderer.camera.zoom)}px`; input.style.height = `${Math.max(58, (existing?.height ?? 72) * this.renderer.camera.zoom)}px`;
    const commit = (): void => { const text = input.value.trim(); const editorRect = input.getBoundingClientRect(); input.remove(); if (!text) return; this.store.checkpoint();
      const width = Math.max(80, editorRect.width / this.renderer.camera.zoom); const height = Math.max(40, editorRect.height / this.renderer.camera.zoom);
      if (existing) { const current = this.store.document.elements.find((element) => element.id === existing.id); if (current?.type === "text") { current.text = text; current.width = width; current.height = Math.max(height, estimateTextHeight(text, width, current.fontSize)); } }
      else { const fontSize = 32; this.store.document.elements.push({ type: "text", id: uuid("text"), x: point.x, baseline: point.y + fontSize, width, height: Math.max(height, estimateTextHeight(text, width, fontSize)), fontSize, color: this.penColor, text }); }
      this.store.changed(); };
    input.addEventListener("blur", commit, { once: true }); input.addEventListener("keydown", (event) => { if (event.key === "Escape") { input.value = ""; input.blur(); } if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); input.blur(); } });
  }

  private bindKeyboard(): void {
    window.addEventListener("keydown", (event) => {
      const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement; if (editing) return;
      if (event.code === "Space") { event.preventDefault(); this.spaceDown = true; this.canvas.classList.add("is-panning"); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? this.store.redo() : this.store.undo(); }
      if ((event.key === "Delete" || event.key === "Backspace") && this.renderer.selectionIds.size) { event.preventDefault(); this.deleteSelection(); }
      const shortcuts: Partial<Record<string, BoardTool>> = { v: "select", h: "hand", p: "pen", i: "ai-pen", r: "rectangle", o: "ellipse", a: "arrow", t: "text", l: "lasso", e: "eraser" };
      const shortcut = shortcuts[event.key.toLowerCase()]; if (shortcut && !event.ctrlKey && !event.metaKey) this.setTool(shortcut);
    });
    window.addEventListener("keyup", (event) => { if (event.code === "Space") { this.spaceDown = false; this.canvas.classList.remove("is-panning"); } });
  }

  private bindCollaboration(): void {
    byId<HTMLButtonElement>("accept").innerHTML = `${icon("check")}<span>Accept</span>`; byId<HTMLButtonElement>("undo-agent").innerHTML = `${icon("close")}<span>Undo</span>`;
    byId<HTMLButtonElement>("send").innerHTML = icon("send"); byId<HTMLButtonElement>("clear-context").innerHTML = icon("close");
    this.requestForm.addEventListener("submit", (event) => { event.preventDefault(); const instruction = this.instruction.value.trim(); const ink = structuredClone(this.renderer.instructionInk); if (!instruction && !ink.length) return;
      this.store.checkpoint(); this.store.document.request = { id: uuid("request"), instruction: instruction || "Nutze die blaue AI-Pen-Markierung als visuelle Anweisung.", selectionIds: [...this.renderer.selectionIds], ink, createdAt: new Date().toISOString(), state: "ready" }; this.store.changed(); this.instruction.value = ""; this.updateContextPrompt(); this.setStatus(ink.length ? "AI-Pen-Anweisung ist für den Agenten bereit" : this.renderer.selectionIds.size ? "Auswahl-Anweisung ist für den Agenten bereit" : "Canvas-Anweisung ist für den Agenten bereit", 2600); });
    byId<HTMLButtonElement>("clear-context").addEventListener("click", () => { this.renderer.selectionIds.clear(); this.renderer.instructionInk = []; this.updateContextPrompt(); this.renderer.request(); });
    byId<HTMLButtonElement>("accept").addEventListener("click", () => { this.store.acceptAgentContribution(); this.renderer.activeAgentIds.clear(); this.renderer.instructionInk = []; this.agentMarkerTip.hidden = true; this.setStatus("Agentenbeitrag übernommen", 1800); });
    byId<HTMLButtonElement>("undo-agent").addEventListener("click", () => { if (this.store.undoAgentContribution()) { this.renderer.activeAgentIds.clear(); this.renderer.instructionInk = []; this.agentMarkerTip.hidden = true; this.setStatus("Agentenbeitrag zurückgenommen", 1800); } });
  }

  private bindFiles(): void {
    this.imageInput.addEventListener("change", () => { const file = this.imageInput.files?.[0]; this.imageInput.value = ""; if (!file) return;
      const reader = new FileReader(); reader.onload = () => { const dataUrl = String(reader.result); const image = new Image(); image.onload = () => { const centre = this.renderer.world(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2); const scale = Math.min(1, 560 / image.naturalWidth);
        const element: ImageElement = { type: "image", id: uuid("image"), x: centre.x - image.naturalWidth * scale / 2, y: centre.y - image.naturalHeight * scale / 2, width: image.naturalWidth * scale, height: image.naturalHeight * scale, dataUrl, mimeType: file.type === "image/png" ? "image/png" : "image/jpeg", sourceName: file.name };
        this.store.checkpoint(); this.store.document.elements.push(element); this.store.changed(); }; image.src = dataUrl; }; reader.readAsDataURL(file);
    });
    byId<HTMLButtonElement>("export-json").addEventListener("click", () => { const blob = new Blob([JSON.stringify(this.store.document, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "shared-whiteboard.json"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); });
    const importInput = byId<HTMLInputElement>("import-json"); importInput.addEventListener("change", () => { const file = importInput.files?.[0]; importInput.value = ""; if (!file) return; void file.text().then((text) => { const parsed = JSON.parse(text) as unknown; if (!validBoard(parsed)) throw new Error("Ungültiges Whiteboard"); this.store.checkpoint(); this.store.replace(parsed); this.renderer.fitAll(); }).catch(() => this.setStatus("Datei konnte nicht geöffnet werden", 2200)); });
  }

  private inspect(scope: "all" | "selection"): Record<string, unknown> {
    const requestIds = this.store.document.request?.state === "answered" ? [] : (this.store.document.request?.selectionIds ?? []); const ids = scope === "selection" ? (requestIds.length ? requestIds : [...this.renderer.selectionIds]) : null;
    const elements = ids ? this.store.document.elements.filter((element) => ids.includes(element.id)) : this.store.document.elements;
    return { revision: this.store.document.revision, coordinateSystem: "Infinite 2D world coordinates; +x right, +y down", viewport: { ...this.renderer.camera, width: this.canvas.clientWidth, height: this.canvas.clientHeight }, pendingRequest: this.store.document.request, selectionBounds: boardBounds(elements), elements: elements.map((element) => ({ ...elementSummary(element), groupId: this.store.groupIdFor(element.id) ?? null })) };
  }

  private async applyAgentOperations(operations: CanvasOperation[], baseRevision?: number, maxOperations = 120, delay = 65): Promise<Record<string, unknown>> {
    if (!Array.isArray(operations) || operations.length === 0) return { ok: false, error: "No operations supplied" };
    if (operations.length > maxOperations || operations.some((operation) => !isCanvasOperation(operation))) return { ok: false, error: "invalid_operations", instruction: `Use the operation schema exactly, keep coordinates finite, and stay below ${maxOperations} operations.` };
    if (baseRevision !== undefined && baseRevision !== this.store.document.revision) return { ok: false, error: "stale_revision", currentRevision: this.store.document.revision, instruction: "Inspect the whiteboard again before editing." };
    const createsElement = new Set(["create_text", "create_highlight", "create_shape", "create_arrow", "create_stroke", "create_polygon", "connect"]); const explicitIds = operations.filter((operation) => createsElement.has(operation.type) && "id" in operation && typeof operation.id === "string").map((operation) => (operation as { id: string }).id); const existing = new Set(this.store.document.elements.map((element) => element.id));
    if (new Set(explicitIds).size !== explicitIds.length || explicitIds.some((id) => existing.has(id))) return { ok: false, error: "id_conflict", instruction: "Use unique IDs that are not already present on the board; inspect again if needed." };
    this.store.beginAgentContribution(); this.updateUi(); this.setStatus("Agent arbeitet auf dem Canvas …"); const created: string[] = [];
    for (const operation of operations.slice(0, maxOperations)) { const targetIds = this.store.expandGroupIds(operationTargetIds(operation)); const ids = this.store.applyOperation(operation, "agent"); created.push(...ids); this.renderer.activeAgentIds = new Set([...this.renderer.activeAgentIds, ...ids, ...targetIds]); this.store.changed(); await new Promise((resolve) => setTimeout(resolve, delay)); }
    return { ok: true, revision: this.store.document.revision, createdIds: created, message: "Changes are visible and remain fully editable. Call complete_whiteboard_contribution when finished." };
  }

  private async composeAgentVisual(input: VisualCompositionInput, baseRevision?: number): Promise<Record<string, unknown>> {
    if (!isVisualComposition(input)) return { ok: false, error: "invalid_visual", instruction: "Use one supported visual kind and provide valid nodes, sections, steps, axes or series." };
    const operations = composeVisual(input); if (!operations.length) return { ok: false, error: "empty_visual" };
    return this.applyAgentOperations(operations, baseRevision, 240, 35);
  }

  private completeAgent(summary: string): Record<string, unknown> {
    if (this.store.document.request) { this.store.document.request.state = "answered"; this.store.document.request.ink = []; } this.renderer.instructionInk = []; this.renderer.request(); this.store.changed(); this.setStatus(summary, 4000); return { ok: true, revision: this.store.document.revision, awaitingHumanDecision: true };
  }

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
  private setStatus(text: string, duration = 0): void { this.status.textContent = text; if (duration) setTimeout(() => { if (this.status.textContent === text) this.status.textContent = ""; }, duration); }
  private updateUi(): void { this.review.hidden = !this.store.hasAgentContribution(); byId<HTMLSpanElement>("revision").textContent = `r${this.store.document.revision}`; this.updateZoom(); this.updateContextPrompt(); }
  private updateZoom(): void { byId<HTMLSpanElement>("zoom").textContent = `${Math.round(this.renderer.camera.zoom * 100)}%`; }
  private updateContextPrompt(): void {
    const tools = byId<HTMLElement>("selection-tools"); const bounds = this.renderer.selectionBounds(); tools.hidden = !bounds;
    const count = this.store.selectionUnitCount([...this.renderer.selectionIds]); const ink = this.renderer.instructionInk.length; byId<HTMLElement>("request-scope").textContent = ink && count ? `AI-Pen + ${count}` : ink ? "AI-Pen" : count ? `${count} ausgewählt` : "Canvas"; byId<HTMLButtonElement>("clear-context").hidden = count === 0 && ink === 0;
    if (!bounds) return;
    const top = this.renderer.screen({ x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY });
    tools.style.left = `${Math.max(170, Math.min(window.innerWidth - 170, top.x))}px`; tools.style.top = `${Math.max(72, top.y - 54)}px`;
    tools.classList.toggle("has-text", this.selectedElements().some((element) => element.type === "text"));
  }

  private updateAgentMarkerHover(event: PointerEvent): void {
    const hit = this.renderer.hit(this.renderer.world(event.clientX, event.clientY), 12);
    if (!hit || !this.renderer.activeAgentIds.has(hit.id)) { this.agentMarkerTip.hidden = true; return; }
    this.agentMarkerTip.hidden = false; this.agentMarkerTip.style.left = `${Math.min(window.innerWidth - 190, event.clientX + 16)}px`; this.agentMarkerTip.style.top = `${Math.max(76, event.clientY - 18)}px`;
  }
}

new WhiteboardApp();
