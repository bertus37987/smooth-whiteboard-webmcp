import { ImageElement, PageElement, ShapeElement, StrokeElement } from "../src/document";
import { InkPoint, beautifyStroke } from "../src/strokes";
import { optimizeShape } from "../src/shapes";
import { BoardRenderer, SelectionHandle } from "./renderer";
import { BoardStore } from "./store";
import { BoardTool, ExplanationSequence, boardBounds, eraseInkElement, erasePolyline, estimateTextHeight, lassoElements, migrateBoard, scaleElement, translateElement } from "./model";
import { CollaborationSession } from "./collaboration";
import { registerWhiteboardTools } from "./webmcp";
import { EnglishHandwritingAssist } from "./handwriting";
import { downloadExport } from "./export";
import { bundledFontFaces } from "../src/rendering";

const icons: Record<string, string> = {
  select: '<path d="M5 3l14 9-7 2-3 7z"/><path d="M13 14l5 5"/>', hand: '<path d="M8 11V7a2 2 0 014 0v3-5a2 2 0 014 0v5-3a2 2 0 014 0v4-2a2 2 0 014 0v5c0 5-3 7-7 7h-1c-3 0-5-2-7-5l-2-3a2 2 0 013-2l2 2"/>',
  pen: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 7l3 3"/>', rectangle: '<rect x="4" y="5" width="16" height="14" rx="1"/>', ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>', arrow: '<path d="M4 12h15M14 7l5 5-5 5"/>',
  "ai-pen": '<path d="M4 20l4-1 10-10-3-3L5 16z"/><path d="M18 3v4M16 5h4M20 11v3M18.5 12.5h3"/>',
  marker: '<path d="M4 17l9-12 6 5-9 11H5z"/><path d="M3 21h18"/>', text: '<path d="M5 6V4h14v2M12 4v16M8 20h8"/>', sticky: '<path d="M5 3h14v13l-5 5H5z"/><path d="M14 21v-5h5"/>', table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16M15 4v16"/>', image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="M4 17l5-5 4 4 2-2 5 4"/>', lasso: '<path d="M19 8c0-3-3-5-7-5S4 5 4 9s4 6 9 6c4 0 7-2 7-5M13 15c0 4-2 6-5 6-2 0-3-1-3-2s1-2 3-2c2 0 4 2 5 4"/>',
  "ai-lasso": '<path d="M19 8c0-3-3-5-7-5S4 5 4 9s4 6 9 6c4 0 7-2 7-5M13 15c0 4-2 6-5 6-2 0-3-1-3-2s1-2 3-2c2 0 4 2 5 4"/><path d="M18 2v3M16.5 3.5h3M20 12v2.5M18.75 13.25h2.5"/>',
  eraser: '<path d="M7 19h12M4 14l8-9a2 2 0 013 0l4 4a2 2 0 010 3l-7 7H8l-4-3a2 2 0 010-2z"/>', undo: '<path d="M9 7l-5 5 5 5"/><path d="M5 12h8a6 6 0 016 6"/>', redo: '<path d="M15 7l5 5-5 5"/><path d="M19 12h-8a6 6 0 00-6 6"/>',
  fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>', trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>', check: '<path d="M5 12l4 4 10-10"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>',
  send: '<path d="M3 12h12M11 7l5 5-5 5"/><path d="M19 7v10"/>', settings: '<path d="M4 6h10M18 6h2M4 12h3M11 12h9M4 18h8M16 18h4"/><circle cx="16" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="14" cy="18" r="2"/>', attach: '<path d="M9 12.5l5.2-5.2a3 3 0 114.2 4.2l-7.1 7.1a5 5 0 11-7.1-7.1l7.1-7.1"/><path d="M8 15.5l7.1-7.1"/>', edit: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 7l3 3"/>', copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 00-2-2H5a2 2 0 00-2 2v9a2 2 0 002 2h3"/>',
  back: '<rect x="4" y="8" width="10" height="10" rx="1"/><path d="M10 8V4h10v10h-6"/>', front: '<rect x="10" y="4" width="10" height="10" rx="1"/><path d="M14 14v4H4V8h6"/>', minus: '<path d="M6 12h12"/>', plus: '<path d="M12 6v12M6 12h12"/>'
  ,shapes: '<rect x="4" y="5" width="11" height="10" rx="2"/><circle cx="17" cy="16" r="4"/>', content: '<path d="M12 4v16M4 12h16"/>', artboard: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h5"/>'
};

function icon(name: string): string { return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[name]}</svg>`; }
function uuid(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }
function byId<T extends HTMLElement>(id: string): T { const element = document.getElementById(id); if (!element) throw new Error(`Missing ${id}`); return element as T; }

interface Interaction {
  mode: "pan" | "draw" | "instruction" | "marker" | "shape" | "artboard" | "lasso" | "move" | "resize" | "erase";
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
  private readonly touchPointers = new Map<number, { x: number; y: number }>();
  private pinch: { distance: number; x: number; y: number } | null = null;
  private readonly status = byId<HTMLSpanElement>("status");
  private readonly review = byId<HTMLDivElement>("review");
  private readonly agentMarkerTip = byId<HTMLDivElement>("agent-marker-tip");
  private readonly imageInput = byId<HTMLInputElement>("image-input");
  private readonly promptInput = byId<HTMLTextAreaElement>("instruction-prompt");
  private readonly promptDock = byId<HTMLElement>("prompt-dock");
  private readonly explanationControls = byId<HTMLElement>("explanation-controls");
  private activeExplanation: { sequence: ExplanationSequence; index: number } | null = null;
  private presentationKey = "";
  private readonly abort = new AbortController();
  private readonly handwriting = new EnglishHandwritingAssist();
  private handwritingTimer = 0;
  private textEditorOpen = false;
  private recentHumanStrokeIds: string[] = [];
  private readonly collaboration = new CollaborationSession(this.store, {
    viewport: () => ({ ...this.renderer.camera, width: this.canvas.clientWidth, height: this.canvas.clientHeight }),
    focus: (bounds) => { this.renderer.fitBounds(bounds); this.updateContextPrompt(); },
    liveSelectionIds: () => [...this.renderer.selectionIds],
    status: (text, duration) => this.setStatus(text, duration),
    refresh: () => { this.renderer.request(); this.updateUi(); },
    operationDelay: () => 35
  });

  constructor() {
    this.renderer.instructionInk = structuredClone(this.store.document.turn?.instructionInk ?? []);
    this.renderer.agentMarkers = structuredClone(this.store.document.turn?.agentMarkers ?? []); this.renderer.activeAgentIds = new Set(this.store.document.turn?.pendingChangeIds ?? []); this.promptInput.value = this.store.document.turn?.promptText ?? "";
    this.bindToolbar(); this.bindSelectionTools(); this.bindCanvas(); this.bindKeyboard(); this.bindCollaboration(); this.bindSettings(); this.bindFiles(); this.bindExplanationControls(); this.bindResponsiveLayout();
    this.store.addEventListener("change", () => { this.renderer.request(); this.updateUi(); });
    this.renderer.request(); this.updateUi();
    void registerWhiteboardTools({
      session: () => this.collaboration.session(),
      waitForTurn: (timeout, signal) => this.collaboration.waitForTurn(timeout, signal),
      inspect: (scope, detail, elementIds) => this.collaboration.inspect(scope, detail, elementIds),
      focus: (bounds, lease) => this.collaboration.focus(bounds, lease),
      publishPlan: (summary, lease) => this.collaboration.publishPlan(summary, lease),
      apply: (operations, revision, lease, signal) => this.collaboration.apply(operations, revision, lease, signal),
      compose: (input, revision, lease, signal) => this.collaboration.compose(input, revision, lease, signal),
      complete: (summary, lease) => this.collaboration.complete(summary, lease)
    }, this.abort.signal)
      .then((available) => this.setStatus(available ? "WebMCP ready" : "Browser without WebMCP – drawing remains available", 2600))
      .catch(() => this.setStatus("WebMCP konnte nicht registriert werden", 2600));
  }

  private bindToolbar(): void {
    document.querySelectorAll<HTMLButtonElement>("button[data-tool]").forEach((button) => {
      const tool = button.dataset.tool as BoardTool; button.innerHTML = icon(tool); button.addEventListener("click", () => this.setTool(tool));
    });
    for (const [id, name, action] of [
      ["undo", "undo", () => this.humanUndo()], ["redo", "redo", () => this.humanRedo()], ["fit", "fit", () => { this.renderer.fitAll(); this.updateContextPrompt(); }], ["clear", "trash", () => this.clearBoard()]
    ] as const) { const button = byId<HTMLButtonElement>(id); button.innerHTML = icon(name); button.addEventListener("click", action); }
    byId<HTMLButtonElement>("image-tool").addEventListener("click", () => this.imageInput.click());
    document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((button) => button.addEventListener("click", () => {
      this.penColor = button.dataset.color ?? "#080808";
      byId<HTMLInputElement>("color-native").value = this.penColor; byId<HTMLInputElement>("color-hex").value = this.penColor;
      document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((candidate) => candidate.classList.toggle("is-active", candidate === button));
    }));
    byId<HTMLButtonElement>("settings-toggle").innerHTML = icon("settings");
    byId<HTMLButtonElement>("shapes-toggle").innerHTML = icon("shapes");
    byId<HTMLButtonElement>("submit-turn").innerHTML = icon("send");
    byId<HTMLButtonElement>("color-picker-toggle").addEventListener("click", () => this.togglePopover("color-popover"));
    byId<HTMLButtonElement>("settings-toggle").addEventListener("click", () => this.togglePopover("settings-popover"));
    byId<HTMLButtonElement>("shapes-toggle").addEventListener("click", () => this.togglePopover("shapes-popover"));
    byId<HTMLButtonElement>("export-toggle").addEventListener("click", () => this.togglePopover("export-popover"));
    this.promptInput.addEventListener("input", () => this.updateContextPrompt());
    this.setTool("pen");
  }

  private setTool(tool: BoardTool): void {
    this.tool = tool; this.canvas.dataset.activeTool = tool; this.canvas.style.cursor = "";
    document.querySelectorAll<HTMLButtonElement>("button[data-tool]").forEach((button) => button.classList.toggle("is-active", button.dataset.tool === tool));
  }

  private togglePopover(id: string): void {
    for (const candidate of ["color-popover", "settings-popover", "shapes-popover", "export-popover"]) { const element = byId<HTMLElement>(candidate); element.hidden = candidate === id ? !element.hidden : true; }
  }

  private bindResponsiveLayout(): void {
    const toolbar = document.querySelector<HTMLElement>(".toolbar"); const utility = document.querySelector<HTMLElement>(".utility");
    if (!toolbar || !utility) return;
    const measure = (): void => {
      const toolbarRect = toolbar.getBoundingClientRect(); const utilityRect = utility.getBoundingClientRect();
      document.documentElement.style.setProperty("--toolbar-bottom", `${Math.ceil(toolbarRect.bottom)}px`);
      document.documentElement.style.setProperty("--utility-bottom", `${Math.ceil(utilityRect.bottom)}px`);
    };
    const observer = new ResizeObserver(measure); observer.observe(toolbar); observer.observe(utility); window.addEventListener("resize", measure); requestAnimationFrame(measure);
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
    this.canvas.addEventListener("wheel", (event) => { event.preventDefault(); const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1); this.zoomAt(event.clientX, event.clientY, Math.exp(-delta * 0.0012)); }, { passive: false });
    this.canvas.addEventListener("dblclick", (event) => {
      if (this.tool !== "select" || !this.collaboration.canHumanMutateBoard()) return; const point = this.renderer.world(event.clientX, event.clientY); const hit = this.renderer.hit(point);
      this.beginText(point, hit?.type === "text" ? hit : undefined);
    });
  }

  private zoomAt(clientX: number, clientY: number, factor: number): void {
    this.renderer.zoomAt(clientX, clientY, factor); this.updateZoom(); this.updateContextPrompt();
  }

  private beginPinch(): void {
    const points = [...this.touchPointers.values()]; if (points.length < 2) return;
    const [first, second] = points; this.pinch = { distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)), x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  }

  private updatePinch(): void {
    const points = [...this.touchPointers.values()]; if (!this.pinch || points.length < 2) return;
    const [first, second] = points; const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)); const x = (first.x + second.x) / 2; const y = (first.y + second.y) / 2;
    this.zoomAt(x, y, distance / this.pinch.distance); this.pinch = { distance, x, y };
  }

  private pointerDown(event: PointerEvent): void {
    const stylusEraser = event.pointerType === "pen" && (event.button === 5 || (event.buttons & 32) === 32);
    if (event.pointerType === "touch") {
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.touchPointers.size >= 2) { event.preventDefault(); this.interaction = null; this.beginPinch(); return; }
    }
    if (event.button !== 0 && event.button !== 1 && !stylusEraser) return;
    // An open text editor commits itself when it loses focus, so this click must not be swallowed
    // and must not start a second field.
    if (this.textEditorOpen) return;
    event.preventDefault(); this.canvas.setPointerCapture(event.pointerId);
    const point = this.renderer.world(event.clientX, event.clientY); const pan = event.button === 1 || this.spaceDown || this.tool === "hand" || event.pointerType === "touch";
    if (pan) { this.interaction = { mode: "pan", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point }; return; }
    if (!this.collaboration.canHumanMutateBoard() && (this.tool !== "select" || stylusEraser)) { this.setStatus(this.collaboration.mutationLockMessage(), 1800); this.release(event); return; }
    if (stylusEraser) { this.interaction = { mode: "erase", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point }; this.erase(point); return; }
    if (this.tool === "select") { this.startSelection(event, point); return; }
    if (this.tool === "pen") {
      this.store.checkpoint(); const stroke: StrokeElement = { type: "stroke", id: uuid("stroke"), color: this.penColor, size: 3, pressureSensitivity: this.store.document.settings.pressure ? 0.7 : 0, points: [{ ...point, pressure: this.store.document.settings.pressure ? event.pressure || 0.5 : 0.5, time: event.timeStamp }], parentId: this.parentArtboardAt(point)?.id };
      this.store.document.elements.push(stroke); this.interaction = { mode: "draw", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, elementId: stroke.id }; this.renderer.request(); return;
    }
    if (this.tool === "ai-pen") {
      const stroke = [{ ...point, pressure: event.pressure || 0.5, time: event.timeStamp }]; this.renderer.instructionInk.push(stroke); this.interaction = { mode: "instruction", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, instructionIndex: this.renderer.instructionInk.length - 1 }; this.updateContextPrompt(); this.renderer.request(); return;
    }
    if (this.tool === "marker") {
      this.store.checkpoint(); const markerId = uuid("highlight"); this.store.document.elements.push({ type: "highlight", id: markerId, x1: point.x, x2: point.x, y: point.y, points: [{ ...point, pressure: event.pressure || .5, time: event.timeStamp }], size: 28, color: this.penColor === "#080808" ? "#ffd84d" : this.penColor, opacity: Math.min(.42, this.opacity * .32), parentId: this.parentArtboardAt(point)?.id });
      this.interaction = { mode: "marker", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, markerId }; this.renderer.request(); return;
    }
    if (this.tool === "rectangle" || this.tool === "ellipse" || this.tool === "arrow") {
      this.store.checkpoint(); const shape: ShapeElement = { type: "shape", id: uuid("shape"), kind: this.tool, points: [point, { ...point }], color: this.penColor, size: 3, closed: this.tool !== "arrow", fillColor: "#c0c0c0", fillOpacity: 0, radius: this.tool === "rectangle" ? 14 : undefined, parentId: this.parentArtboardAt(point)?.id };
      this.store.document.elements.push(shape); this.interaction = { mode: "shape", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, elementId: shape.id }; this.renderer.request(); return;
    }
    if (this.tool === "lasso" || this.tool === "ai-lasso") { this.renderer.lasso = [point]; this.renderer.lassoMode = this.tool === "ai-lasso" ? "ai" : "select"; this.interaction = { mode: "lasso", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, additive: event.shiftKey }; this.renderer.request(); return; }
    if (this.tool === "eraser") { this.interaction = { mode: "erase", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point }; this.erase(point); return; }
    if (this.tool === "text") { this.beginText(point); this.release(event); }
    else if (this.tool === "sticky") { this.beginText(point, undefined, "body", true); this.release(event); }
    else if (this.tool === "artboard") {
      this.store.checkpoint(); const shape: ShapeElement = { type: "shape", id: uuid("artboard"), kind: "rectangle", points: [point, { ...point }], color: "#808080", size: 1.5, closed: true, fillColor: "#ffffff", fillOpacity: 1, radius: 24, semanticRole: "artboard", name: "Artboard", artboard: { preset: "custom", backgroundColor: "#ffffff", clipContent: false } };
      this.store.document.elements.push(shape); this.store.document.artboardIds.push(shape.id); this.interaction = { mode: "artboard", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, elementId: shape.id }; this.renderer.request();
    }
    else if (this.tool === "image") this.release(event);
  }

  private startSelection(event: PointerEvent, point: InkPoint): void {
    const selected = this.store.document.elements.filter((element) => this.renderer.selectionIds.has(element.id));
    const handle = selected.length > 0 && this.collaboration.canHumanMutateBoard() ? this.renderer.selectionHandleAt(point) : null;
    if (handle) {
      this.interaction = { mode: "resize", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, before: new Map(selected.map((element) => [element.id, structuredClone(element)])), beforeBounds: boardBounds(selected) ?? undefined, handle }; return;
    }
    const hit = this.renderer.hit(point); if (hit?.locked) return;
    if (!hit) { this.renderer.selectionIds.clear(); this.updateContextPrompt(); this.renderer.request(); return; }
    this.updateContextPrompt(); const hitIds = this.store.expandGroupIds([hit.id]);
    if (!event.shiftKey && !hitIds.every((id) => this.renderer.selectionIds.has(id))) this.renderer.selectionIds = new Set(hitIds);
    else if (event.shiftKey) { const remove = hitIds.every((id) => this.renderer.selectionIds.has(id)); hitIds.forEach((id) => remove ? this.renderer.selectionIds.delete(id) : this.renderer.selectionIds.add(id)); }
    if (!this.collaboration.canHumanMutateBoard()) { this.updateContextPrompt(); this.renderer.request(); return; }
    const elements = this.store.document.elements.filter((element) => this.renderer.selectionIds.has(element.id));
    this.interaction = { mode: "move", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, before: new Map(elements.map((element) => [element.id, structuredClone(element)])) }; this.updateContextPrompt(); this.renderer.request();
  }

  private pointerMove(event: PointerEvent): void {
    if (event.pointerType === "touch" && this.touchPointers.has(event.pointerId)) {
      this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pinch && this.touchPointers.size >= 2) { event.preventDefault(); this.updatePinch(); return; }
    }
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
    if (interaction.mode === "marker") {
      const marker = this.store.document.elements.find((element) => element.id === interaction.markerId); if (marker?.type !== "highlight") return;
      const samples = event.getCoalescedEvents?.() ?? [event]; marker.points ??= [{ ...interaction.startWorld }];
      for (const sample of samples) { const candidate = this.renderer.world(sample.clientX, sample.clientY); candidate.pressure = sample.pressure || .5; candidate.time = sample.timeStamp; const previous = marker.points.at(-1); if (!previous || Math.hypot(candidate.x - previous.x, candidate.y - previous.y) >= .7 / this.renderer.camera.zoom) marker.points.push(candidate); }
      marker.x2 = point.x; marker.y = point.y; this.renderer.request(); return;
    }
    if (interaction.mode === "shape" || interaction.mode === "artboard") { const shape = this.store.document.elements.find((element): element is ShapeElement => element.id === interaction.elementId && element.type === "shape"); if (shape) { shape.points[1] = point; this.renderer.request(); } return; }
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
    if (event.pointerType === "touch") {
      this.touchPointers.delete(event.pointerId);
      if (this.pinch) { this.pinch = this.touchPointers.size >= 2 ? this.pinch : null; this.interaction = null; this.release(event); return; }
    }
    const interaction = this.interaction; if (!interaction || interaction.pointerId !== event.pointerId) { this.release(event); return; }
    if (interaction.mode === "lasso") {
      const unlocked = this.store.document.elements.filter((element) => !element.locked); const hits = this.store.expandGroupIds(lassoElements(unlocked, this.renderer.lasso)).filter((id) => !this.store.document.elements.find((element) => element.id === id)?.locked);
      if (this.renderer.lassoMode === "ai") this.attachToAgent(hits, interaction.additive === true);
      else this.renderer.selectionIds = interaction.additive ? new Set([...this.renderer.selectionIds, ...hits]) : new Set(hits);
      this.renderer.lasso = []; this.updateContextPrompt(); this.renderer.request();
    } else if (interaction.mode === "draw") {
      const strokeIndex = this.store.document.elements.findIndex((element) => element.id === interaction.elementId);
      const stroke = this.store.document.elements[strokeIndex];
      if (stroke?.type === "stroke") {
        if (this.store.document.settings.inputSmoothing && stroke.points.length > 3) stroke.points = beautifyStroke(stroke.points, .16);
        const optimized = this.store.document.settings.autoShape ? optimizeShape(stroke) : { kind: null };
        if (optimized.kind) this.store.document.elements[strokeIndex] = { type: "shape", id: stroke.id, kind: optimized.kind, points: optimized.stroke!.points, color: stroke.color, size: stroke.size, closed: optimized.kind !== "line" && optimized.kind !== "arrow", fillColor: "#c0c0c0", fillOpacity: 0 };
        else { this.recentHumanStrokeIds.push(stroke.id); this.recentHumanStrokeIds = this.recentHumanStrokeIds.slice(-18); this.scheduleHandwritingAssist(); }
      }
      this.store.changed();
    } else if (interaction.mode === "instruction") this.updateContextPrompt();
    else if (interaction.mode === "marker") {
      const marker = this.store.document.elements.find((element) => element.id === interaction.markerId); if (marker?.type === "highlight") { const end = this.renderer.world(event.clientX, event.clientY); end.pressure = event.pressure || .5; end.time = event.timeStamp; marker.points ??= [{ ...interaction.startWorld }]; const previous = marker.points.at(-1); if (!previous || Math.hypot(end.x - previous.x, end.y - previous.y) > .5) marker.points.push(end); marker.x2 = end.x; marker.y = end.y; }
      this.finishMarker(interaction.markerId); this.store.changed();
    }
    else if (interaction.mode === "shape" || interaction.mode === "artboard" || interaction.mode === "erase" || interaction.checkpointed) this.store.changed();
    this.interaction = null; this.release(event);
  }

  /** The AI lasso hands objects to the agent: they glow blue and ride along with the next request. */
  private attachToAgent(ids: string[], additive: boolean): void {
    if (!this.guardHumanMutation()) return;
    const wanted = new Set(ids);
    this.store.checkpoint();
    for (const element of this.store.document.elements) {
      if (wanted.has(element.id)) element.agentAttached = true;
      else if (!additive) delete element.agentAttached;
    }
    this.store.changed();
    this.setStatus(ids.length ? `${this.store.selectionUnitCount(ids)} attached for the agent` : "Nothing inside the lasso", 2000);
  }

  private resizeCursor(handle: SelectionHandle | null): string {
    if (!handle) return "default"; if (handle === "n" || handle === "s") return "ns-resize"; if (handle === "e" || handle === "w") return "ew-resize";
    return handle === "nw" || handle === "se" ? "nwse-resize" : "nesw-resize";
  }

  private release(event: PointerEvent): void { if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId); }

  private erase(point: InkPoint): void {
    const radius = 14 / this.renderer.camera.zoom;
    const instructionBefore = this.renderer.instructionInk.length; this.renderer.instructionInk = this.renderer.instructionInk.flatMap((stroke) => erasePolyline(stroke, point, radius));
    let changedPermanent = false; const next: PageElement[] = []; const wholeHit = this.renderer.hit(point, 14);
    for (const element of this.store.document.elements) {
      if (element.locked) { next.push(element); continue; }
      const replacement = eraseInkElement(element, point, radius); if (replacement === null) next.push(element); else { next.push(...replacement); changedPermanent = true; if (!replacement.length) this.renderer.selectionIds.delete(element.id); }
    }
    const deleteWhole = wholeHit && !wholeHit.locked && wholeHit.type !== "stroke" && !(wholeHit.type === "highlight" && wholeHit.points?.length) ? wholeHit.id : null; if (deleteWhole) changedPermanent = true;
    if (changedPermanent && !this.interaction?.checkpointed) { this.store.checkpoint(); if (this.interaction) this.interaction.checkpointed = true; }
    this.store.document.elements = deleteWhole ? next.filter((element) => element.id !== deleteWhole) : next; if (deleteWhole) this.renderer.selectionIds.delete(deleteWhole);
    if (instructionBefore !== this.renderer.instructionInk.length || changedPermanent) this.updateContextPrompt(); this.renderer.request();
  }

  private finishMarker(markerId?: string): void {
    const marker = this.store.document.elements.find((element) => element.id === markerId); if (marker?.type !== "highlight") return;
    const points = marker.points ?? []; const length = points.slice(1).reduce((total, point, index) => total + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
    if (length < 4) { this.store.document.elements = this.store.document.elements.filter((element) => element.id !== marker.id); return; }
    const gesture = boardBounds([{ ...marker, points }]); const primarilyHorizontal = Boolean(gesture && gesture.maxX - gesture.minX >= (gesture.maxY - gesture.minY) * 1.2);
    if (this.store.document.settings.smartHighlight && primarilyHorizontal && gesture) {
      const centreY = points.reduce((sum, point) => sum + point.y, 0) / points.length; const minX = gesture.minX + marker.size / 2; const maxX = gesture.maxX - marker.size / 2; const radius = marker.size * .8;
      const boxes = this.store.document.elements.filter((element) => element.id !== marker.id && (element.type === "text" || element.type === "stroke")).map((element) => ({ bounds: boardBounds([element])! })).filter(({ bounds }) => bounds.maxX >= minX && bounds.minX <= maxX && bounds.maxY >= centreY - radius && bounds.minY <= centreY + radius);
      if (boxes.length) { marker.x1 = Math.min(...boxes.map(({ bounds }) => bounds.minX)) - 7; marker.x2 = Math.max(...boxes.map(({ bounds }) => bounds.maxX)) + 7; marker.y = boxes.reduce((sum, { bounds }) => sum + (bounds.minY + bounds.maxY) / 2, 0) / boxes.length; marker.size = Math.max(18, Math.min(42, Math.max(...boxes.map(({ bounds }) => bounds.maxY - bounds.minY)) * .72)); delete marker.points; }
    }
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
    if (!stillCurrent || !this.collaboration.canHumanMutateBoard()) return; strokes.forEach((stroke) => { const current = this.store.document.elements.find((element) => element.id === stroke.id); if (current?.type === "stroke") current.recognitionText = text; }); this.store.changed();
  }

  private beginText(point: InkPoint, existing?: Extract<PageElement, { type: "text" }>, initialStyle: Extract<PageElement, { type: "text" }>["blockStyle"] = "body", sticky = false): void {
    if (!this.collaboration.canHumanMutateBoard()) { this.setStatus(this.collaboration.mutationLockMessage(), 1800); return; }
    const shell = document.createElement("div"); shell.className = "text-editor-shell"; const controls = document.createElement("div"); controls.className = "text-controls";
    const select = (label: string, values: Array<[string, string]>, current: string): HTMLSelectElement => { const element = document.createElement("select"); element.setAttribute("aria-label", label); for (const [value, text] of values) { const option = document.createElement("option"); option.value = value; option.textContent = text; element.appendChild(option); } element.value = current; return element; };
    const style = select("Text style", [["body", "Text"], ["heading-1", "Title"], ["heading-2", "Heading"], ["heading-3", "Subheading"], ["bullet", "Bullets"], ["numbered", "Numbered"], ["check", "Checklist"], ["quote", "Quote"], ["code", "Code"], ["math", "Math"]], existing?.blockStyle ?? initialStyle ?? "body");
    const family = select("Font", [["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"], ["handwriting", "Handwriting"]], existing?.fontFamily ?? "sans");
    const size = document.createElement("input"); size.type = "number"; size.min = "10"; size.max = "180"; size.step = "1"; size.value = String(Math.round(existing?.fontSize ?? (initialStyle === "heading-1" ? 48 : initialStyle === "heading-2" ? 38 : 20))); size.setAttribute("aria-label", "Font size");
    const formatButton = (label: string, text: string, pressed: boolean): HTMLButtonElement => { const button = document.createElement("button"); button.type = "button"; button.setAttribute("aria-label", label); button.setAttribute("aria-pressed", String(pressed)); button.textContent = text; return button; };
    const bold = formatButton("Bold", "B", (existing?.fontWeight ?? 400) >= 600); const italic = formatButton("Italic", "I", existing?.fontStyle === "italic"); const underline = formatButton("Underline", "U", existing?.textDecoration === "underline"); underline.classList.add("is-underline");
    const alignLeft = formatButton("Align left", "≡", (existing?.textAlign ?? "left") === "left"); const alignCenter = formatButton("Align center", "≡", existing?.textAlign === "center"); const alignRight = formatButton("Align right", "≡", existing?.textAlign === "right"); alignLeft.classList.add("align-left"); alignCenter.classList.add("align-center"); alignRight.classList.add("align-right");
    const color = document.createElement("input"); color.type = "color"; color.value = existing?.color ?? this.penColor; color.setAttribute("aria-label", "Textfarbe");
    const done = document.createElement("button"); done.type = "button"; done.className = "text-done"; done.textContent = "Done";
    const input = document.createElement("textarea"); input.setAttribute("aria-label", "Text on whiteboard"); input.rows = 3; input.spellcheck = true;
    const group = (...children: HTMLElement[]): HTMLSpanElement => { const element = document.createElement("span"); element.className = "text-control-group"; element.append(...children); return element; };
    controls.append(group(style, family, size), group(bold, italic, underline), group(alignLeft, alignCenter, alignRight), group(color), done); shell.append(controls, input);
    let alignment: "left" | "center" | "right" = existing?.textAlign ?? "left";
    const toggle = (button: HTMLButtonElement): void => button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
    const updatePreview = (): void => { const families = { sans: "Inter, system-ui, sans-serif", serif: "Georgia, serif", mono: "Consolas, monospace", handwriting: "'Segoe Print', cursive" }; input.style.fontFamily = families[family.value as keyof typeof families]; input.style.fontSize = `${Math.max(10, Math.min(180, Number(size.value) || 30)) * this.renderer.camera.zoom}px`; input.style.lineHeight = "1.22"; input.style.fontWeight = bold.getAttribute("aria-pressed") === "true" ? "700" : "400"; input.style.fontStyle = italic.getAttribute("aria-pressed") === "true" ? "italic" : "normal"; input.style.textDecoration = underline.getAttribute("aria-pressed") === "true" ? "underline" : "none"; input.style.textAlign = alignment; input.style.color = color.value; };
    for (const button of [bold, italic, underline]) button.addEventListener("click", () => { toggle(button); updatePreview(); input.focus(); });
    for (const [button, value] of [[alignLeft, "left"], [alignCenter, "center"], [alignRight, "right"]] as const) button.addEventListener("click", () => { alignment = value; for (const candidate of [alignLeft, alignCenter, alignRight]) candidate.setAttribute("aria-pressed", String(candidate === button)); updatePreview(); input.focus(); });
    for (const control of [family, size, color]) control.addEventListener("input", updatePreview); style.addEventListener("change", () => { if (!existing) { if (style.value === "heading-1") size.value = "48"; else if (style.value === "heading-2") size.value = "38"; else if (style.value === "heading-3") size.value = "32"; } updatePreview(); });
    const anchor = existing ? { x: existing.x, y: existing.baseline - existing.fontSize } : point;
    const screen = this.renderer.screen(anchor); const rect = this.canvas.getBoundingClientRect(); input.value = existing?.text ?? ""; document.body.appendChild(shell);
    const editorWidth = Math.min(window.innerWidth - 20, Math.max(160, (existing?.width ?? (sticky ? 320 : 260)) * this.renderer.camera.zoom + 30)); const editorHeight = Math.min(window.innerHeight - 20, Math.max(sticky ? 190 : 120, (existing?.height ?? (sticky ? 160 : 72)) * this.renderer.camera.zoom + 96));
    shell.style.width = `${editorWidth}px`; shell.style.height = `${editorHeight}px`; updatePreview();
    // Line the typed text up with where it will actually land, instead of the editor's outer corner.
    const padding = window.getComputedStyle(input);
    const inset = { x: input.offsetLeft + Number.parseFloat(padding.paddingLeft || "0"), y: input.offsetTop + Number.parseFloat(padding.paddingTop || "0") };
    shell.style.left = `${Math.max(10, Math.min(window.innerWidth - editorWidth - 10, rect.left + screen.x - inset.x))}px`;
    shell.style.top = `${Math.max(10, Math.min(window.innerHeight - editorHeight - 10, rect.top + screen.y - inset.y))}px`;
    this.textEditorOpen = true; input.focus(); input.select();
    let committed = false; const commit = (): void => { if (committed || !shell.isConnected) return; committed = true; this.textEditorOpen = false; const text = input.value.trim(); const editorRect = shell.getBoundingClientRect(); const contentHeight = Math.max(40, (editorRect.height - controls.getBoundingClientRect().height) / this.renderer.camera.zoom);
      // Measure the text area while it is still in the document; removing the shell zeroes it.
      const contentWidth = input.clientWidth - Number.parseFloat(padding.paddingLeft || "0") - Number.parseFloat(padding.paddingRight || "0");
      shell.remove(); if (!text || !this.guardHumanMutation()) return; this.store.checkpoint();
      const width = Math.max(160, contentWidth / this.renderer.camera.zoom); const fontSize = Math.max(10, Math.min(180, Number(size.value) || 20)); const fontWeight = bold.getAttribute("aria-pressed") === "true" ? 700 as const : 400 as const; const fontStyle = italic.getAttribute("aria-pressed") === "true" ? "italic" as const : "normal" as const; const textDecoration = underline.getAttribute("aria-pressed") === "true" ? "underline" as const : "none" as const;
      if (existing) { const current = this.store.document.elements.find((element) => element.id === existing.id); if (current?.type === "text") { current.text = text; current.width = width; current.blockStyle = style.value as typeof current.blockStyle; current.fontSize = fontSize; current.fontFamily = family.value as typeof current.fontFamily; current.fontWeight = fontWeight; current.fontStyle = fontStyle; current.textDecoration = textDecoration; current.textAlign = alignment; current.color = color.value; current.height = Math.max(contentHeight, estimateTextHeight(text, width, fontSize, current)); } }
      else if (sticky) { const ids = this.store.applyOperation({ type: "create_note", x: point.x, y: point.y, width, height: Math.max(100, contentHeight), text, color: color.value, blockStyle: style.value as Extract<PageElement, { type: "text" }>["blockStyle"] }, "human"); const parentId = this.parentArtboardAt(point)?.id; ids.forEach((id) => { const element = this.store.document.elements.find((candidate) => candidate.id === id); if (element) element.parentId = parentId; }); }
      else { const element: Extract<PageElement, { type: "text" }> = { type: "text", id: uuid("text"), x: point.x, baseline: point.y + fontSize, width, height: Math.max(contentHeight, estimateTextHeight(text, width, fontSize, { fontFamily: family.value as Extract<PageElement, { type: "text" }>["fontFamily"], fontWeight, fontStyle, blockStyle: style.value as Extract<PageElement, { type: "text" }>["blockStyle"] })), fontSize, color: color.value, text, fontFamily: family.value as Extract<PageElement, { type: "text" }>["fontFamily"], fontWeight, fontStyle, textDecoration, textAlign: alignment, blockStyle: style.value as Extract<PageElement, { type: "text" }>["blockStyle"], semanticRole: "text-field", parentId: this.parentArtboardAt(point)?.id }; this.store.document.elements.push(element); }
      this.store.changed(); };
    const cancel = (): void => { if (committed) return; committed = true; this.textEditorOpen = false; shell.remove(); };
    done.addEventListener("click", commit); shell.addEventListener("focusout", () => window.setTimeout(() => { if (shell.isConnected && !shell.contains(document.activeElement)) commit(); }, 0)); input.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commit(); this.submitHumanTurn(); } });
  }

  private bindKeyboard(): void {
    window.addEventListener("keydown", (event) => {
      const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); this.submitHumanTurn(); return; } if (editing) return;
      if (event.code === "Space") { event.preventDefault(); this.spaceDown = true; this.canvas.classList.add("is-panning"); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? this.humanRedo() : this.humanUndo(); }
      if ((event.key === "Delete" || event.key === "Backspace") && this.renderer.selectionIds.size) { event.preventDefault(); this.deleteSelection(); }
      const shortcuts: Partial<Record<string, BoardTool>> = { v: "select", h: "hand", p: "pen", i: "ai-pen", m: "marker", n: "sticky", r: "rectangle", o: "ellipse", a: "arrow", t: "text", l: "lasso", k: "ai-lasso", e: "eraser" };
      const shortcut = shortcuts[event.key.toLowerCase()]; if (shortcut && !event.ctrlKey && !event.metaKey) this.setTool(shortcut);
    });
    window.addEventListener("keyup", (event) => { if (event.code === "Space") { this.spaceDown = false; this.canvas.classList.remove("is-panning"); } });
  }

  private bindCollaboration(): void {
    byId<HTMLButtonElement>("accept").innerHTML = `${icon("check")}<span>Accept</span>`; byId<HTMLButtonElement>("undo-agent").innerHTML = `${icon("close")}<span>Reject</span>`;
    byId<HTMLButtonElement>("submit-turn").addEventListener("click", () => this.submitHumanTurn());
    byId<HTMLButtonElement>("accept").addEventListener("click", () => { if (!this.collaboration.accept()) { this.setStatus("The agent is still editing", 1800); return; } this.promptInput.value = ""; this.clearAgentOverlay(); this.setStatus("Agent proposal accepted", 1800); });
    byId<HTMLButtonElement>("undo-agent").addEventListener("click", () => { if (!this.collaboration.reject()) { this.setStatus("The agent is still editing", 1800); return; } this.clearAgentOverlay(); this.setStatus("Agent proposal rejected", 1800); });
  }

  private bindSettings(): void {
    const pairs = [["setting-smoothing", "inputSmoothing"], ["setting-pressure", "pressure"], ["setting-auto-shape", "autoShape"], ["setting-smart-highlight", "smartHighlight"], ["setting-english-assist", "englishHandwritingAssist"]] as const;
    for (const [id, key] of pairs) { const input = byId<HTMLInputElement>(id); input.checked = this.store.document.settings[key]; input.addEventListener("change", () => { if (!this.guardHumanMutation()) { input.checked = this.store.document.settings[key]; return; } this.store.document.settings[key] = input.checked; if (key === "englishHandwritingAssist" && !input.checked) { window.clearTimeout(this.handwritingTimer); this.store.document.elements.forEach((element) => { if (element.type === "stroke") delete element.recognitionText; }); } this.store.changed(); }); }
    const native = byId<HTMLInputElement>("color-native"); const hex = byId<HTMLInputElement>("color-hex"); const opacity = byId<HTMLInputElement>("color-opacity"); const apply = (value: string) => { if (!/^#[0-9a-f]{6}$/i.test(value)) return; this.penColor = value.toLowerCase(); native.value = this.penColor; hex.value = this.penColor; document.querySelectorAll("[data-color]").forEach((item) => item.classList.remove("is-active")); if (this.renderer.selectionIds.size && this.collaboration.canHumanMutateBoard()) { this.store.checkpoint(); this.store.applyOperation({ type: "update_style", ids: [...this.renderer.selectionIds], color: this.penColor, opacity: this.opacity }, "human"); this.store.changed(); } };
    native.addEventListener("input", () => apply(native.value)); hex.addEventListener("change", () => apply(hex.value)); opacity.addEventListener("input", () => { this.opacity = Number(opacity.value) / 100; });
    byId<HTMLElement>("handwriting-support").textContent = this.handwriting.supported() ? "Local English recognition is available; visible ink remains unchanged." : "No local OS recognition available; only gentle geometric smoothing is used.";
  }

  private bindFiles(): void {
    this.imageInput.addEventListener("change", () => { const file = this.imageInput.files?.[0]; this.imageInput.value = ""; if (!file) return; if (!this.guardHumanMutation()) return;
      const reader = new FileReader(); reader.onload = () => { const dataUrl = String(reader.result); const image = new Image(); image.onload = () => { const centre = this.renderer.world(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2); const scale = Math.min(1, 560 / image.naturalWidth);
        const element: ImageElement = { type: "image", id: uuid("image"), x: centre.x - image.naturalWidth * scale / 2, y: centre.y - image.naturalHeight * scale / 2, width: image.naturalWidth * scale, height: image.naturalHeight * scale, dataUrl, mimeType: file.type === "image/png" ? "image/png" : "image/jpeg", sourceName: file.name, parentId: this.parentArtboardAt(centre)?.id };
        this.store.checkpoint(); this.store.document.elements.push(element); this.store.changed(); }; image.src = dataUrl; }; reader.readAsDataURL(file);
    });
    document.querySelectorAll<HTMLButtonElement>("[data-export]").forEach((button) => button.addEventListener("click", () => { const format = button.dataset.export as "png" | "svg" | "pdf" | "json"; void downloadExport(format, this.store.document, [...this.renderer.selectionIds]).then(() => { this.togglePopover("export-popover"); this.setStatus(`${format.toUpperCase()} exported`, 1800); }).catch(() => this.setStatus("Export failed", 2200)); }));
    const importInput = byId<HTMLInputElement>("import-json"); importInput.addEventListener("change", () => { const file = importInput.files?.[0]; importInput.value = ""; if (!file) return; if (!this.guardHumanMutation()) return; void file.text().then((text) => { const parsed = migrateBoard(JSON.parse(text) as unknown); if (!parsed) throw new Error("Invalid whiteboard"); this.store.checkpoint(); this.store.replace(parsed); this.renderer.fitAll(); }).catch(() => this.setStatus("Could not open file", 2200)); });
  }

  /** One entry point for a human turn: the session owns validation, context freezing and queueing. */
  private submitHumanTurn(): void {
    const outcome = this.collaboration.submit({ promptText: this.promptInput.value, instructionInk: this.renderer.instructionInk, selectionIds: [...this.renderer.selectionIds] });
    this.setStatus(outcome.message, 2400);
    if (outcome.ok) this.renderer.instructionInk = structuredClone(this.store.document.turn?.instructionInk ?? []);
    this.updateUi();
  }


  private parentArtboardAt(point: InkPoint): ShapeElement | undefined {
    return [...this.store.document.elements].reverse().find((element): element is ShapeElement => { if (element.type !== "shape" || !element.artboard) return false; const bounds = boardBounds([element])!; return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY; });
  }

  private bindExplanationControls(): void {
    byId<HTMLButtonElement>("explanation-prev").addEventListener("click", () => this.stepExplanation(-1)); byId<HTMLButtonElement>("explanation-next").addEventListener("click", () => this.stepExplanation(1));
    byId<HTMLButtonElement>("explanation-overview").addEventListener("click", () => { this.store.document.presentation = null; this.store.changed("metadata"); });
    this.syncExplanation();
  }

  /** The active step lives in the document, so a reload keeps it and the agent can move it with present_step. */
  private stepExplanation(delta: number): void {
    const current = this.activeExplanation; const sequence = current?.sequence ?? this.store.document.explanationSequences[0]; if (!sequence?.steps.length) return;
    const index = current ? Math.max(0, Math.min(sequence.steps.length - 1, current.index + delta)) : delta < 0 ? sequence.steps.length - 1 : 0;
    this.store.document.presentation = { sequenceId: sequence.id, index }; this.store.changed("metadata");
  }

  private syncExplanation(): void {
    const presentation = this.store.document.presentation ?? null;
    const sequence = presentation ? this.store.document.explanationSequences.find((candidate) => candidate.id === presentation.sequenceId) : undefined;
    const state = sequence?.steps.length ? { sequence, index: Math.max(0, Math.min(sequence.steps.length - 1, presentation!.index)) } : null;
    this.activeExplanation = state; this.renderer.explanationState = state;
    const key = state ? `${state.sequence.id}:${state.index}` : "";
    if (key && key !== this.presentationKey) {
      const step = state!.sequence.steps[state!.index];
      const focus = step.cameraBounds ?? boardBounds(this.store.document.elements.filter((element) => step.focusElementIds.includes(element.id)));
      if (focus) this.renderer.fitBounds(focus);
    }
    this.presentationKey = key; this.renderer.request(); this.refreshExplanationControls();
  }

  private refreshExplanationControls(): void {
    const active = this.activeExplanation; const sequence = active?.sequence ?? this.store.document.explanationSequences[0]; this.explanationControls.hidden = !sequence; if (!sequence) return;
    const step = active ? sequence.steps[active.index] : null;
    byId<HTMLElement>("explanation-title").textContent = step ? `${active!.index + 1}/${sequence.steps.length} · ${step.title}` : `${sequence.title} · Overview`;
    const body = byId<HTMLElement>("explanation-body"); body.textContent = step?.body ?? ""; body.hidden = !step?.body;
  }

  private clearBoard(): void { if (!this.guardHumanMutation() || this.store.document.elements.length === 0 || !window.confirm("Clear the entire whiteboard?")) return; this.renderer.selectionIds.clear(); this.store.clear(); }
  private selectedElements(): PageElement[] { return this.store.document.elements.filter((element) => this.renderer.selectionIds.has(element.id)); }
  private duplicateSelection(): void {
    if (!this.collaboration.canHumanMutateBoard()) { this.setStatus(this.collaboration.mutationLockMessage(), 1800); return; }
    const selected = this.selectedElements(); if (!selected.length) return; this.store.checkpoint(); const created = this.store.applyOperation({ type: "duplicate", ids: selected.map((element) => element.id), dx: 24, dy: 24 }, "human");
    this.renderer.selectionIds = new Set(created); this.store.changed();
  }
  private reorderSelection(direction: "front" | "back"): void { if (!this.collaboration.canHumanMutateBoard()) { this.setStatus(this.collaboration.mutationLockMessage(), 1800); return; } const ids = [...this.renderer.selectionIds]; if (!ids.length) return; this.store.checkpoint(); this.store.applyOperation({ type: "reorder", ids, direction }, "human"); this.store.changed(); }
  private resizeSelectedText(delta: number): void {
    if (!this.collaboration.canHumanMutateBoard()) { this.setStatus(this.collaboration.mutationLockMessage(), 1800); return; }
    const texts = this.selectedElements().filter((element): element is Extract<PageElement, { type: "text" }> => element.type === "text"); if (!texts.length) return; this.store.checkpoint();
    for (const text of texts) { text.fontSize = Math.max(10, Math.min(180, text.fontSize + delta)); text.height = estimateTextHeight(text.text, text.width, text.fontSize, text); } this.store.changed();
  }
  private deleteSelection(): void {
    if (!this.collaboration.canHumanMutateBoard()) { this.setStatus(this.collaboration.mutationLockMessage(), 1800); return; }
    const ids = [...this.renderer.selectionIds]; if (!ids.length) return; this.store.checkpoint(); this.store.applyOperation({ type: "delete", ids }, "human"); this.renderer.selectionIds.clear(); this.store.changed();
  }
  private toggleAgentAttachment(): void {
    if (!this.collaboration.canHumanMutateBoard()) { this.setStatus(this.collaboration.mutationLockMessage(), 1800); return; }
    const ids = this.store.expandGroupIds([...this.renderer.selectionIds]); const elements = this.store.document.elements.filter((element) => ids.includes(element.id)); if (!elements.some((element) => element.semanticRole === "note" || element.semanticRole === "note-body")) return;
    const attached = elements.some((element) => element.agentAttached); this.store.checkpoint(); elements.forEach((element) => { element.agentAttached = !attached; }); this.store.changed(); this.setStatus(attached ? "Note detached" : "Note will be attached on next submit", 2200);
  }
  private setStatus(text: string, duration = 0): void { this.status.textContent = text; if (duration) setTimeout(() => { if (this.status.textContent === text) this.status.textContent = ""; }, duration); }
  /** Single gate for every human board mutation; returns false and explains when the agent owns the canvas. */
  private guardHumanMutation(): boolean {
    if (this.collaboration.canHumanMutateBoard()) return true;
    this.setStatus(this.collaboration.mutationLockMessage(), 1800); return false;
  }
  private humanUndo(): void { if (this.guardHumanMutation()) this.store.undo(); }
  private humanRedo(): void { if (this.guardHumanMutation()) this.store.redo(); }
  private clearAgentOverlay(): void {
    this.renderer.activeAgentIds.clear(); this.renderer.instructionInk = []; this.renderer.agentMarkers = []; this.agentMarkerTip.hidden = true; this.updateContextPrompt(); this.renderer.request();
  }
  private updateUi(): void {
    const state = this.collaboration.state();
    // Accept / Reject may only appear once the agent has finished streaming.
    this.review.hidden = state !== "review";
    this.renderer.agentMarkers = structuredClone(this.store.document.turn?.agentMarkers ?? []);
    if (this.store.hasAgentContribution()) this.renderer.activeAgentIds = new Set(this.store.document.turn?.pendingChangeIds ?? []);
    byId<HTMLSpanElement>("revision").textContent = `r${this.store.document.revision}`;
    const submit = byId<HTMLButtonElement>("submit-turn"); const busy = ["queued", "claimed", "planning", "working", "review"].includes(state);
    submit.classList.toggle("is-waiting", busy && state !== "review"); submit.disabled = busy;
    this.syncExplanation(); this.updateZoom(); this.updateContextPrompt();
  }
  private updateZoom(): void { byId<HTMLSpanElement>("zoom").textContent = `${Math.round(this.renderer.camera.zoom * 100)}%`; }
  private updateContextPrompt(): void {
    const tools = byId<HTMLElement>("selection-tools"); const bounds = this.renderer.selectionBounds(); tools.hidden = !bounds;
    const selected = this.selectedElements(); const count = this.store.selectionUnitCount([...this.renderer.selectionIds]); const ink = this.renderer.instructionInk.length; const prompt = this.promptInput.value.trim().length > 0;
    const typeNames: Record<PageElement["type"], string> = { stroke: "Ink", text: "Text", highlight: "Marker", shape: "Shape", image: "Image" }; const selectedKinds = [...new Set(selected.map((element) => element.name ?? (element.artboard ? "Artboard" : typeNames[element.type])))].slice(0, 2);
    const attachedIds = this.store.document.elements.filter((element) => element.agentAttached).map((element) => element.id); const attachedCount = this.store.selectionUnitCount(attachedIds); const scopes: string[] = [];
    if (count) scopes.push(`${count} selected${selectedKinds.length ? ` · ${selectedKinds.join(", ")}` : ""}`); if (ink) scopes.push(ink === 1 ? "AI Pen" : `${ink}× AI Pen`); if (attachedCount) scopes.push(`${attachedCount} attached`); if (prompt) scopes.push("Text prompt"); if (!scopes.length) scopes.push("Entire canvas");
    const scope = byId<HTMLElement>("request-scope"); scope.replaceChildren(...scopes.map((label) => { const chip = document.createElement("span"); chip.textContent = label; chip.title = label; return chip; }));
    this.promptDock.classList.toggle("has-prompt", prompt); this.promptInput.style.height = "40px"; const promptHeight = Math.min(112, Math.max(40, this.promptInput.scrollHeight)); this.promptInput.style.height = `${promptHeight}px`; document.documentElement.style.setProperty("--prompt-dock-height", `${this.promptDock.offsetHeight}px`);
    if (!bounds) return;
    const top = this.renderer.screen({ x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY });
    tools.style.left = `${Math.max(170, Math.min(window.innerWidth - 170, top.x))}px`; tools.style.top = `${Math.max(72, top.y - 54)}px`;
    tools.classList.toggle("has-text", selected.some((element) => element.type === "text")); tools.classList.toggle("has-note", selected.some((element) => element.semanticRole === "note" || element.semanticRole === "note-body")); byId<HTMLButtonElement>("attach-agent").classList.toggle("is-active", selected.some((element) => element.agentAttached));
  }

  private updateAgentMarkerHover(event: PointerEvent): void {
    const hit = this.renderer.agentMarkerAt(this.renderer.world(event.clientX, event.clientY));
    if (!hit) { this.agentMarkerTip.hidden = true; return; }
    this.agentMarkerTip.hidden = false; this.agentMarkerTip.style.left = `${Math.min(window.innerWidth - 190, event.clientX + 16)}px`; this.agentMarkerTip.style.top = `${Math.max(76, event.clientY - 18)}px`;
  }
}

/**
 * Element heights are measured once and kept in the document, so the bundled faces have to be
 * ready before anything is measured or drawn. Browsers without the font API just start.
 */
async function boot(): Promise<void> {
  try {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts) { await Promise.all(bundledFontFaces.map((face) => fonts.load(face))); await fonts.ready; }
  } catch { /* a missing or blocked font file must never stop the whiteboard */ }
  new WhiteboardApp();
}

void boot();
