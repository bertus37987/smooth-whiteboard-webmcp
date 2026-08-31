import { ImageElement, PageElement, ShapeElement, StrokeElement } from "../src/document";
import { InkPoint } from "../src/strokes";
import { optimizeShape } from "../src/shapes";
import { BoardRenderer } from "./renderer";
import { BoardStore } from "./store";
import { BoardTool, CanvasOperation, boardBounds, elementSummary, lassoElements, scaleElement, translateElement, validBoard } from "./model";
import { registerWhiteboardTools } from "./webmcp";

const icons: Record<string, string> = {
  select: '<path d="M5 3l14 9-7 2-3 7z"/><path d="M13 14l5 5"/>', hand: '<path d="M8 11V7a2 2 0 014 0v3-5a2 2 0 014 0v5-3a2 2 0 014 0v4-2a2 2 0 014 0v5c0 5-3 7-7 7h-1c-3 0-5-2-7-5l-2-3a2 2 0 013-2l2 2"/>',
  pen: '<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 7l3 3"/>', rectangle: '<rect x="4" y="5" width="16" height="14" rx="1"/>', ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>', arrow: '<path d="M4 12h15M14 7l5 5-5 5"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M8 20h8"/>', image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="M4 17l5-5 4 4 2-2 5 4"/>', lasso: '<path d="M19 8c0-3-3-5-7-5S4 5 4 9s4 6 9 6c4 0 7-2 7-5M13 15c0 4-2 6-5 6-2 0-3-1-3-2s1-2 3-2c2 0 4 2 5 4"/>',
  eraser: '<path d="M7 19h12M4 14l8-9a2 2 0 013 0l4 4a2 2 0 010 3l-7 7H8l-4-3a2 2 0 010-2z"/>', undo: '<path d="M9 7l-5 5 5 5"/><path d="M5 12h8a6 6 0 016 6"/>', redo: '<path d="M15 7l5 5-5 5"/><path d="M19 12h-8a6 6 0 00-6 6"/>',
  fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>', trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>', check: '<path d="M5 12l4 4 10-10"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>', send: '<path d="M4 4l17 8-17 8 3-8zM7 12h14"/>'
};

function icon(name: string): string { return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`; }
function uuid(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }
function byId<T extends HTMLElement>(id: string): T { const element = document.getElementById(id); if (!element) throw new Error(`Missing ${id}`); return element as T; }

interface Interaction {
  mode: "pan" | "draw" | "shape" | "lasso" | "move" | "resize" | "erase";
  pointerId: number; startClient: { x: number; y: number }; startWorld: InkPoint; elementId?: string;
  before?: Map<string, PageElement>; beforeBounds?: { minX: number; minY: number; maxX: number; maxY: number }; checkpointed?: boolean;
}

export class WhiteboardApp {
  private readonly store = new BoardStore();
  private readonly canvas = byId<HTMLCanvasElement>("board");
  private readonly renderer = new BoardRenderer(this.canvas, () => this.store.document.elements);
  private tool: BoardTool = "pen";
  private penColor = "#080808";
  private lassoPromptOpen = false;
  private interaction: Interaction | null = null;
  private spaceDown = false;
  private readonly status = byId<HTMLSpanElement>("status");
  private readonly requestForm = byId<HTMLFormElement>("agent-form");
  private readonly instruction = byId<HTMLInputElement>("instruction");
  private readonly review = byId<HTMLDivElement>("review");
  private readonly imageInput = byId<HTMLInputElement>("image-input");
  private readonly abort = new AbortController();

  constructor() {
    this.bindToolbar(); this.bindCanvas(); this.bindKeyboard(); this.bindCollaboration(); this.bindFiles();
    this.store.addEventListener("change", () => { this.renderer.request(); this.updateUi(); });
    this.renderer.request(); this.updateUi();
    void registerWhiteboardTools({ inspect: (scope) => this.inspect(scope), apply: (operations, revision) => this.applyAgentOperations(operations, revision), complete: (summary) => this.completeAgent(summary) }, this.abort.signal)
      .then((available) => this.setStatus(available ? "WebMCP bereit" : "Browser ohne WebMCP – Zeichnen bleibt vollständig verfügbar", 2600))
      .catch(() => this.setStatus("WebMCP konnte nicht registriert werden", 2600));
  }

  private bindToolbar(): void {
    document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => {
      const tool = button.dataset.tool as BoardTool; button.innerHTML = icon(tool); button.addEventListener("click", () => this.setTool(tool));
    });
    for (const [id, name, action] of [
      ["undo", "undo", () => this.store.undo()], ["redo", "redo", () => this.store.redo()], ["fit", "fit", () => this.renderer.fitAll()], ["clear", "trash", () => this.clearBoard()]
    ] as const) { const button = byId<HTMLButtonElement>(id); button.innerHTML = icon(name); button.addEventListener("click", action); }
    byId<HTMLButtonElement>("image-tool").addEventListener("click", () => this.imageInput.click());
    document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((button) => button.addEventListener("click", () => {
      this.penColor = button.dataset.color ?? "#080808";
      document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((candidate) => candidate.classList.toggle("is-active", candidate === button));
    }));
    this.setTool("pen");
  }

  private setTool(tool: BoardTool): void {
    this.tool = tool; this.canvas.dataset.tool = tool;
    document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((button) => button.classList.toggle("is-active", button.dataset.tool === tool));
  }

  private bindCanvas(): void {
    this.canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    this.canvas.addEventListener("pointercancel", (event) => this.pointerUp(event));
    this.canvas.addEventListener("wheel", (event) => { event.preventDefault(); this.renderer.zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0012)); this.updateZoom(); }, { passive: false });
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
    if (this.tool === "rectangle" || this.tool === "ellipse" || this.tool === "arrow") {
      this.store.checkpoint(); const shape: ShapeElement = { type: "shape", id: uuid("shape"), kind: this.tool, points: [point, { ...point }], color: this.penColor, size: 3, closed: this.tool !== "arrow", fillColor: "#c0c0c0", fillOpacity: 0 };
      this.store.document.elements.push(shape); this.interaction = { mode: "shape", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, elementId: shape.id }; this.renderer.request(); return;
    }
    if (this.tool === "lasso") { this.renderer.lasso = [point]; this.interaction = { mode: "lasso", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point }; this.renderer.request(); return; }
    if (this.tool === "eraser") { this.interaction = { mode: "erase", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point }; this.erase(point); return; }
    if (this.tool === "text") { this.beginText(point); this.release(event); }
    else if (this.tool === "image") this.release(event);
  }

  private startSelection(event: PointerEvent, point: InkPoint): void {
    const selected = this.store.document.elements.filter((element) => this.renderer.selectionIds.has(element.id));
    if (selected.length > 0 && this.renderer.onResizeHandle(point)) {
      this.interaction = { mode: "resize", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, before: new Map(selected.map((element) => [element.id, structuredClone(element)])), beforeBounds: boardBounds(selected) ?? undefined }; return;
    }
    const hit = this.renderer.hit(point);
    if (!hit) { this.renderer.selectionIds.clear(); this.lassoPromptOpen = false; this.updateContextPrompt(); this.renderer.request(); return; }
    if (!event.shiftKey && !this.renderer.selectionIds.has(hit.id)) this.renderer.selectionIds = new Set([hit.id]);
    else if (event.shiftKey) this.renderer.selectionIds.has(hit.id) ? this.renderer.selectionIds.delete(hit.id) : this.renderer.selectionIds.add(hit.id);
    const elements = this.store.document.elements.filter((element) => this.renderer.selectionIds.has(element.id));
    this.interaction = { mode: "move", pointerId: event.pointerId, startClient: { x: event.clientX, y: event.clientY }, startWorld: point, before: new Map(elements.map((element) => [element.id, structuredClone(element)])) }; this.renderer.request();
  }

  private pointerMove(event: PointerEvent): void {
    const interaction = this.interaction; if (!interaction || interaction.pointerId !== event.pointerId) return; event.preventDefault();
    const point = this.renderer.world(event.clientX, event.clientY);
    if (interaction.mode === "pan") { this.renderer.camera.x += event.clientX - interaction.startClient.x; this.renderer.camera.y += event.clientY - interaction.startClient.y; interaction.startClient = { x: event.clientX, y: event.clientY }; this.renderer.request(); return; }
    if (interaction.mode === "draw") {
      const stroke = this.store.document.elements.find((element): element is StrokeElement => element.id === interaction.elementId && element.type === "stroke"); if (!stroke) return;
      const samples = event.getCoalescedEvents?.() ?? [event]; for (const sample of samples) { const candidate = this.renderer.world(sample.clientX, sample.clientY); candidate.pressure = sample.pressure || 0.5; candidate.time = sample.timeStamp; stroke.points.push(candidate); } this.renderer.request(); return;
    }
    if (interaction.mode === "shape") { const shape = this.store.document.elements.find((element): element is ShapeElement => element.id === interaction.elementId && element.type === "shape"); if (shape) { shape.points[1] = point; this.renderer.request(); } return; }
    if (interaction.mode === "lasso") { this.renderer.lasso.push(point); this.renderer.request(); return; }
    if (interaction.mode === "erase") { this.erase(point); return; }
    const dx = point.x - interaction.startWorld.x; const dy = point.y - interaction.startWorld.y;
    if (!interaction.checkpointed && Math.hypot(dx, dy) > 1) { this.store.checkpoint(); interaction.checkpointed = true; }
    if (interaction.mode === "move" && interaction.before) {
      for (const [id, before] of interaction.before) { const index = this.store.document.elements.findIndex((element) => element.id === id); if (index >= 0) { this.store.document.elements[index] = structuredClone(before); translateElement(this.store.document.elements[index], dx, dy); } } this.renderer.request();
    } else if (interaction.mode === "resize" && interaction.before && interaction.beforeBounds) {
      const from = interaction.beforeBounds; const to = { minX: from.minX, minY: from.minY, maxX: Math.max(from.minX + 8, point.x), maxY: Math.max(from.minY + 8, point.y) };
      for (const [id, before] of interaction.before) { const index = this.store.document.elements.findIndex((element) => element.id === id); if (index >= 0) { this.store.document.elements[index] = structuredClone(before); scaleElement(this.store.document.elements[index], from, to); } } this.renderer.request();
    }
  }

  private pointerUp(event: PointerEvent): void {
    const interaction = this.interaction; if (!interaction || interaction.pointerId !== event.pointerId) { this.release(event); return; }
    if (interaction.mode === "lasso") {
      this.renderer.selectionIds = new Set(lassoElements(this.store.document.elements, this.renderer.lasso)); this.renderer.lasso = []; this.lassoPromptOpen = this.renderer.selectionIds.size > 0; this.setTool("select"); this.updateContextPrompt(); this.renderer.request();
    } else if (interaction.mode === "draw") {
      const strokeIndex = this.store.document.elements.findIndex((element) => element.id === interaction.elementId);
      const stroke = this.store.document.elements[strokeIndex];
      if (stroke?.type === "stroke") {
        const optimized = optimizeShape(stroke);
        if (optimized.kind) this.store.document.elements[strokeIndex] = { type: "shape", id: stroke.id, kind: optimized.kind, points: optimized.stroke.points, color: stroke.color, size: stroke.size, closed: optimized.kind !== "line" && optimized.kind !== "arrow", fillColor: "#c0c0c0", fillOpacity: 0 };
      }
      this.store.changed();
    } else if (interaction.mode === "shape" || interaction.mode === "erase" || interaction.checkpointed) this.store.changed();
    this.interaction = null; this.release(event);
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
    const commit = (): void => { const text = input.value.trim(); input.remove(); if (!text) return; this.store.checkpoint();
      if (existing) { const current = this.store.document.elements.find((element) => element.id === existing.id); if (current?.type === "text") { current.text = text; current.width = Math.max(80, text.length * current.fontSize * 0.58); } }
      else { const fontSize = 32; this.store.document.elements.push({ type: "text", id: uuid("text"), x: point.x, baseline: point.y + fontSize, width: Math.max(120, text.length * fontSize * 0.58), fontSize, color: this.penColor, text }); }
      this.store.changed(); };
    input.addEventListener("blur", commit, { once: true }); input.addEventListener("keydown", (event) => { if (event.key === "Escape") { input.value = ""; input.blur(); } if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); input.blur(); } });
  }

  private bindKeyboard(): void {
    window.addEventListener("keydown", (event) => {
      const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement; if (editing) return;
      if (event.code === "Space") { event.preventDefault(); this.spaceDown = true; this.canvas.classList.add("is-panning"); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? this.store.redo() : this.store.undo(); }
      if ((event.key === "Delete" || event.key === "Backspace") && this.renderer.selectionIds.size) { event.preventDefault(); this.store.checkpoint(); const ids = [...this.renderer.selectionIds]; this.store.applyOperation({ type: "delete", ids }, "human"); this.renderer.selectionIds.clear(); this.store.changed(); }
      const shortcuts: Partial<Record<string, BoardTool>> = { v: "select", h: "hand", p: "pen", r: "rectangle", o: "ellipse", a: "arrow", t: "text", l: "lasso", e: "eraser" };
      const shortcut = shortcuts[event.key.toLowerCase()]; if (shortcut && !event.ctrlKey && !event.metaKey) this.setTool(shortcut);
    });
    window.addEventListener("keyup", (event) => { if (event.code === "Space") { this.spaceDown = false; this.canvas.classList.remove("is-panning"); } });
  }

  private bindCollaboration(): void {
    byId<HTMLButtonElement>("accept").innerHTML = `${icon("check")}<span>Accept</span>`; byId<HTMLButtonElement>("undo-agent").innerHTML = `${icon("close")}<span>Undo</span>`;
    byId<HTMLButtonElement>("send").innerHTML = icon("send"); byId<HTMLButtonElement>("close-prompt").innerHTML = icon("close");
    this.requestForm.addEventListener("submit", (event) => { event.preventDefault(); const instruction = this.instruction.value.trim(); if (!instruction) return;
      this.store.checkpoint(); this.store.document.request = { id: uuid("request"), instruction, selectionIds: [...this.renderer.selectionIds], createdAt: new Date().toISOString(), state: "ready" }; this.store.changed(); this.instruction.value = ""; this.lassoPromptOpen = false; this.updateContextPrompt(); this.setStatus("Lasso-Anweisung ist für den Browser-Agenten bereit", 2600); });
    byId<HTMLButtonElement>("close-prompt").addEventListener("click", () => { this.lassoPromptOpen = false; this.updateContextPrompt(); });
    byId<HTMLButtonElement>("accept").addEventListener("click", () => { this.store.acceptAgentContribution(); this.renderer.activeAgentIds.clear(); this.setStatus("Agentenbeitrag übernommen", 1800); });
    byId<HTMLButtonElement>("undo-agent").addEventListener("click", () => { if (this.store.undoAgentContribution()) { this.renderer.activeAgentIds.clear(); this.setStatus("Agentenbeitrag zurückgenommen", 1800); } });
  }

  private bindFiles(): void {
    this.imageInput.addEventListener("change", () => { const file = this.imageInput.files?.[0]; this.imageInput.value = ""; if (!file) return;
      const reader = new FileReader(); reader.onload = () => { const dataUrl = String(reader.result); const image = new Image(); image.onload = () => { const centre = this.renderer.world(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2); const scale = Math.min(1, 560 / image.naturalWidth);
        const element: ImageElement = { type: "image", id: uuid("image"), x: centre.x - image.naturalWidth * scale / 2, y: centre.y - image.naturalHeight * scale / 2, width: image.naturalWidth * scale, height: image.naturalHeight * scale, dataUrl, mimeType: file.type === "image/png" ? "image/png" : "image/jpeg", sourceName: file.name };
        this.store.checkpoint(); this.store.document.elements.push(element); this.store.changed(); this.setTool("select"); }; image.src = dataUrl; }; reader.readAsDataURL(file);
    });
    byId<HTMLButtonElement>("export-json").addEventListener("click", () => { const blob = new Blob([JSON.stringify(this.store.document, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "shared-whiteboard.json"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); });
    const importInput = byId<HTMLInputElement>("import-json"); importInput.addEventListener("change", () => { const file = importInput.files?.[0]; importInput.value = ""; if (!file) return; void file.text().then((text) => { const parsed = JSON.parse(text) as unknown; if (!validBoard(parsed)) throw new Error("Ungültiges Whiteboard"); this.store.checkpoint(); this.store.replace(parsed); this.renderer.fitAll(); }).catch(() => this.setStatus("Datei konnte nicht geöffnet werden", 2200)); });
  }

  private inspect(scope: "all" | "selection"): Record<string, unknown> {
    const requestIds = this.store.document.request?.selectionIds ?? []; const ids = scope === "selection" ? (requestIds.length ? requestIds : [...this.renderer.selectionIds]) : null;
    const elements = ids ? this.store.document.elements.filter((element) => ids.includes(element.id)) : this.store.document.elements;
    return { revision: this.store.document.revision, coordinateSystem: "Infinite 2D world coordinates; +x right, +y down", viewport: { ...this.renderer.camera, width: this.canvas.clientWidth, height: this.canvas.clientHeight }, pendingRequest: this.store.document.request, selectionBounds: boardBounds(elements), elements: elements.map(elementSummary) };
  }

  private async applyAgentOperations(operations: CanvasOperation[], baseRevision?: number): Promise<Record<string, unknown>> {
    if (!Array.isArray(operations) || operations.length === 0) return { ok: false, error: "No operations supplied" };
    if (baseRevision !== undefined && baseRevision !== this.store.document.revision) return { ok: false, error: "stale_revision", currentRevision: this.store.document.revision, instruction: "Inspect the whiteboard again before editing." };
    this.store.beginAgentContribution(); this.updateUi(); const created: string[] = [];
    for (const operation of operations.slice(0, 80)) { const ids = this.store.applyOperation(operation, "agent"); created.push(...ids); this.renderer.activeAgentIds = new Set([...this.renderer.activeAgentIds, ...ids]); this.store.changed(); await new Promise((resolve) => setTimeout(resolve, 90)); }
    return { ok: true, revision: this.store.document.revision, createdIds: created, message: "Changes are visible and remain fully editable. Call complete_whiteboard_contribution when finished." };
  }

  private completeAgent(summary: string): Record<string, unknown> {
    if (this.store.document.request) this.store.document.request.state = "answered"; this.store.changed(); this.setStatus(summary, 4000); return { ok: true, revision: this.store.document.revision, awaitingHumanDecision: true };
  }

  private clearBoard(): void { if (this.store.document.elements.length === 0 || !window.confirm("Gesamtes Whiteboard leeren?")) return; this.renderer.selectionIds.clear(); this.store.clear(); }
  private setStatus(text: string, duration = 0): void { this.status.textContent = text; if (duration) setTimeout(() => { if (this.status.textContent === text) this.status.textContent = ""; }, duration); }
  private updateUi(): void { this.review.hidden = !this.store.hasAgentContribution(); byId<HTMLSpanElement>("revision").textContent = `r${this.store.document.revision}`; this.updateZoom(); this.updateContextPrompt(); }
  private updateZoom(): void { byId<HTMLSpanElement>("zoom").textContent = `${Math.round(this.renderer.camera.zoom * 100)}%`; }
  private updateContextPrompt(): void {
    const panel = byId<HTMLElement>("lasso-prompt"); const bounds = this.renderer.selectionBounds(); panel.hidden = !this.lassoPromptOpen || !bounds;
    if (!bounds || panel.hidden) return;
    const anchor = this.renderer.screen({ x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY });
    panel.style.left = `${Math.max(220, Math.min(window.innerWidth - 220, anchor.x))}px`; panel.style.top = `${Math.min(window.innerHeight - 92, anchor.y + 18)}px`;
  }
}

new WhiteboardApp();
