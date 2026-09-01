import { PageElement, elementBounds } from "../src/document";
import { InkPoint } from "../src/strokes";
import { cachedImage, drawBoardElement } from "../src/rendering";
import { AgentMarkerAnnotation, Camera, ExplanationSequence, boardBounds } from "./model";

export type SelectionHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export class BoardRenderer {
  readonly camera: Camera = { x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 };
  selectionIds = new Set<string>();
  lasso: InkPoint[] = [];
  instructionInk: InkPoint[][] = [];
  agentMarkers: AgentMarkerAnnotation[] = [];
  activeAgentIds = new Set<string>();
  explanationState: { sequence: ExplanationSequence; index: number } | null = null;
  private frame = 0;
  private resizeObserver: ResizeObserver;

  constructor(readonly canvas: HTMLCanvasElement, private readonly elements: () => PageElement[], private readonly connectionLabelIds: () => Set<string> = () => new Set()) {
    this.resizeObserver = new ResizeObserver(() => this.request()); this.resizeObserver.observe(canvas);
  }

  destroy(): void { this.resizeObserver.disconnect(); cancelAnimationFrame(this.frame); }

  request(): void { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); }); }

  world(clientX: number, clientY: number): InkPoint {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (clientX - rect.left - this.camera.x) / this.camera.zoom, y: (clientY - rect.top - this.camera.y) / this.camera.zoom, pressure: 0.5 };
  }

  screen(point: { x: number; y: number }): { x: number; y: number } { return { x: point.x * this.camera.zoom + this.camera.x, y: point.y * this.camera.zoom + this.camera.y }; }

  zoomAt(clientX: number, clientY: number, factor: number): void {
    const before = this.world(clientX, clientY); this.camera.zoom = Math.max(0.15, Math.min(5, this.camera.zoom * factor));
    const rect = this.canvas.getBoundingClientRect(); this.camera.x = clientX - rect.left - before.x * this.camera.zoom; this.camera.y = clientY - rect.top - before.y * this.camera.zoom; this.request();
  }

  fitAll(): void {
    const bounds = boardBounds(this.elements()); const rect = this.canvas.getBoundingClientRect();
    if (!bounds || rect.width <= 0 || rect.height <= 0) { this.camera.x = rect.width / 2; this.camera.y = rect.height / 2; this.camera.zoom = 1; this.request(); return; }
    const width = Math.max(100, bounds.maxX - bounds.minX); const height = Math.max(100, bounds.maxY - bounds.minY);
    this.camera.zoom = Math.max(0.15, Math.min(2, Math.min((rect.width - 160) / width, (rect.height - 180) / height)));
    this.camera.x = rect.width / 2 - (bounds.minX + bounds.maxX) / 2 * this.camera.zoom;
    this.camera.y = rect.height / 2 - (bounds.minY + bounds.maxY) / 2 * this.camera.zoom; this.request();
  }

  fitBounds(bounds: { minX: number; minY: number; maxX: number; maxY: number }): void {
    const rect = this.canvas.getBoundingClientRect(); const width = Math.max(80, bounds.maxX - bounds.minX); const height = Math.max(80, bounds.maxY - bounds.minY);
    this.camera.zoom = Math.max(.15, Math.min(3, Math.min((rect.width - 220) / width, (rect.height - 220) / height)));
    this.camera.x = rect.width / 2 - (bounds.minX + bounds.maxX) / 2 * this.camera.zoom; this.camera.y = rect.height / 2 - (bounds.minY + bounds.maxY) / 2 * this.camera.zoom; this.request();
  }

  selectionBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    return boardBounds(this.elements().filter((element) => this.selectionIds.has(element.id)));
  }

  hit(point: InkPoint, tolerance = 9): PageElement | null {
    const margin = tolerance / this.camera.zoom;
    return [...this.elements()].reverse().find((element) => {
      const box = elementBounds(element);
      return point.x >= box.minX - margin && point.x <= box.maxX + margin && point.y >= box.minY - margin && point.y <= box.maxY + margin;
    }) ?? null;
  }

  agentMarkerAt(point: InkPoint): AgentMarkerAnnotation | null {
    const radius = 18 / this.camera.zoom;
    return [...this.agentMarkers].reverse().find((marker) => {
      if (marker.points?.some((candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y) <= radius)) return true;
      return marker.x !== undefined && marker.y !== undefined && Math.abs(point.x - marker.x) <= 170 / this.camera.zoom && Math.abs(point.y - marker.y) <= 90 / this.camera.zoom;
    }) ?? null;
  }

  selectionHandleAt(point: InkPoint): SelectionHandle | null {
    const bounds = this.selectionBounds(); if (!bounds) return null; const radius = 12 / this.camera.zoom;
    const midX = (bounds.minX + bounds.maxX) / 2; const midY = (bounds.minY + bounds.maxY) / 2;
    const handles: Array<[SelectionHandle, number, number]> = [
      ["nw", bounds.minX, bounds.minY], ["n", midX, bounds.minY], ["ne", bounds.maxX, bounds.minY], ["e", bounds.maxX, midY],
      ["se", bounds.maxX, bounds.maxY], ["s", midX, bounds.maxY], ["sw", bounds.minX, bounds.maxY], ["w", bounds.minX, midY]
    ];
    return handles.find(([, x, y]) => Math.hypot(point.x - x, point.y - y) <= radius)?.[0] ?? null;
  }

  private drawGrid(context: CanvasRenderingContext2D, width: number, height: number): void {
    context.save(); context.fillStyle = "#ffffff"; context.fillRect(0, 0, width, height);
    const gap = 32 * this.camera.zoom; if (gap < 8) { context.restore(); return; }
    const offsetX = ((this.camera.x % gap) + gap) % gap; const offsetY = ((this.camera.y % gap) + gap) % gap;
    context.fillStyle = "rgba(128,128,128,.26)";
    for (let x = offsetX; x < width; x += gap) for (let y = offsetY; y < height; y += gap) context.fillRect(Math.round(x), Math.round(y), 1, 1);
    context.restore();
  }

  private draw(): void {
    const rect = this.canvas.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return;
    const ratio = window.devicePixelRatio || 1; const targetWidth = Math.round(rect.width * ratio); const targetHeight = Math.round(rect.height * ratio);
    if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) { this.canvas.width = targetWidth; this.canvas.height = targetHeight; }
    const context = this.canvas.getContext("2d"); if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, rect.width, rect.height); this.drawGrid(context, rect.width, rect.height);
    context.save(); context.translate(this.camera.x, this.camera.y); context.scale(this.camera.zoom, this.camera.zoom);
    const step = this.explanationState; const sequenceIds = new Set(step?.sequence.steps.flatMap((item) => item.revealElementIds) ?? []); const revealedIds = new Set(step ? step.sequence.steps.slice(0, step.index + 1).flatMap((item) => item.revealElementIds) : []); const focusIds = new Set(step?.sequence.steps[step.index]?.focusElementIds ?? []);
    for (const element of this.elements()) {
      if (step && sequenceIds.has(element.id) && !revealedIds.has(element.id)) continue;
      if (this.connectionLabelIds().has(element.id) && element.type === "text") this.drawConnectionLabel(context, element);
      context.save(); if (step && revealedIds.has(element.id) && !focusIds.has(element.id)) context.globalAlpha = .22;
      if (element.type === "image") {
        const image = cachedImage(element, () => this.request()); if (image.complete && image.naturalWidth > 0) context.drawImage(image, element.x, element.y, element.width, element.height);
      } else { context.save(); context.globalAlpha *= element.opacity ?? 1; drawBoardElement(context, element); context.restore(); }
      context.restore();
      if (element.agentAttached && element.semanticRole === "note") this.drawAttachmentBadge(context, element);
    }
    this.drawPendingAgentChanges(context);
    this.drawInstructionInk(context); this.drawAgentMarkers(context); this.drawSelection(context); this.drawLasso(context); context.restore();
  }

  private drawInstructionInk(context: CanvasRenderingContext2D): void {
    if (!this.instructionInk.length) return; context.save(); context.lineCap = "round"; context.lineJoin = "round";
    const draw = () => { for (const stroke of this.instructionInk) { if (!stroke.length) continue; context.beginPath(); context.moveTo(stroke[0].x, stroke[0].y); for (const point of stroke.slice(1)) context.lineTo(point.x, point.y); context.stroke(); } };
    context.strokeStyle = "rgba(158,202,255,.38)"; context.lineWidth = 15 / this.camera.zoom; context.shadowColor = "rgba(133,190,255,.8)"; context.shadowBlur = 26 / this.camera.zoom; draw();
    context.shadowBlur = 8 / this.camera.zoom; context.strokeStyle = "rgba(255,255,255,.96)"; context.lineWidth = 7 / this.camera.zoom; draw();
    context.shadowBlur = 0; context.strokeStyle = "#73adff"; context.lineWidth = 2.2 / this.camera.zoom; draw();
    context.restore();
  }

  private drawPendingAgentChanges(context: CanvasRenderingContext2D): void {
    const active = this.elements().filter((element) => this.activeAgentIds.has(element.id)); const box = boardBounds(active); if (!box) return;
    const pad = 9 / this.camera.zoom; context.save(); context.strokeStyle = "rgba(64,64,64,.72)"; context.lineWidth = 1.5 / this.camera.zoom; context.setLineDash([6 / this.camera.zoom, 5 / this.camera.zoom]); context.strokeRect(box.minX - pad, box.minY - pad, box.maxX - box.minX + pad * 2, box.maxY - box.minY + pad * 2); context.setLineDash([]);
    const label = "Proposal"; context.font = `${12 / this.camera.zoom}px system-ui`; const width = context.measureText(label).width + 14 / this.camera.zoom; const height = 23 / this.camera.zoom; const x = box.minX - pad; const y = box.minY - pad - height - 4 / this.camera.zoom; context.fillStyle = "rgba(255,255,255,.98)"; context.strokeStyle = "rgba(64,64,64,.45)"; context.beginPath(); context.roundRect(x, y, width, height, 7 / this.camera.zoom); context.fill(); context.stroke(); context.fillStyle = "#404040"; context.textBaseline = "middle"; context.fillText(label, x + 7 / this.camera.zoom, y + height / 2); context.restore();
  }

  private drawAgentMarkers(context: CanvasRenderingContext2D): void {
    if (!this.agentMarkers.length) return; context.save(); context.lineCap = "round"; context.lineJoin = "round";
    const paths = this.agentMarkers.filter((marker) => marker.points?.length);
    const drawPaths = (): void => { for (const marker of paths) { const points = marker.points!; context.beginPath(); context.moveTo(points[0].x, points[0].y); for (const point of points.slice(1)) context.lineTo(point.x, point.y); context.stroke(); } };
    context.strokeStyle = "rgba(255,178,188,.38)"; context.lineWidth = 15 / this.camera.zoom; context.shadowColor = "rgba(255,150,164,.78)"; context.shadowBlur = 26 / this.camera.zoom; drawPaths();
    context.strokeStyle = "rgba(255,255,255,.96)"; context.lineWidth = 7 / this.camera.zoom; context.shadowBlur = 8 / this.camera.zoom; drawPaths();
    context.strokeStyle = "#e32636"; context.lineWidth = 2.2 / this.camera.zoom; context.shadowBlur = 0; drawPaths();
    for (const marker of this.agentMarkers) if (marker.text && marker.x !== undefined && marker.y !== undefined) {
      const unit = 1 / this.camera.zoom; const fontSize = 15 * unit; const maxWidth = 310 * unit; const paddingX = 18 * unit; const paddingY = 10 * unit; const lineHeight = 20 * unit;
      context.font = `${fontSize}px 'Segoe Print', cursive`; const lines: string[] = []; let line = "";
      for (const word of marker.text.split(/\s+/)) { const candidate = line ? `${line} ${word}` : word; if (line && context.measureText(candidate).width > maxWidth) { lines.push(line); line = word; } else line = candidate; }
      if (line) lines.push(line); const visible = lines.slice(0, 4); if (lines.length > visible.length) visible[visible.length - 1] = `${visible.at(-1)!.replace(/[.…]*$/, "")} …`;
      const width = Math.min(maxWidth, Math.max(90 * unit, ...visible.map((item) => context.measureText(item).width))) + paddingX * 2; const height = visible.length * lineHeight + paddingY * 2; const x = marker.x; const y = marker.y - fontSize;
      context.shadowColor = "rgba(227,38,54,.32)"; context.shadowBlur = 20 * unit; context.fillStyle = "rgba(255,255,255,.97)"; context.strokeStyle = "rgba(227,38,54,.72)"; context.lineWidth = 1.5 * unit; context.beginPath(); context.roundRect(x, y, width, height, 13 * unit); context.fill(); context.shadowBlur = 0; context.stroke();
      context.fillStyle = "#e32636"; context.beginPath(); context.arc(x + 10 * unit, y + 11 * unit, 3.2 * unit, 0, Math.PI * 2); context.fill(); context.fillStyle = "#8d1522"; context.textBaseline = "top";
      visible.forEach((item, index) => context.fillText(item, x + paddingX, y + paddingY + index * lineHeight));
    }
    context.restore();
  }

  private drawAttachmentBadge(context: CanvasRenderingContext2D, element: PageElement): void {
    const box = elementBounds(element); const radius = 12 / this.camera.zoom; const x = box.maxX - radius * .4; const y = box.minY + radius * .4;
    context.save(); context.fillStyle = "#080808"; context.strokeStyle = "#ffffff"; context.lineWidth = 2 / this.camera.zoom; context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill(); context.stroke();
    context.strokeStyle = "#ffffff"; context.lineWidth = 1.7 / this.camera.zoom; context.lineCap = "round"; context.beginPath(); context.arc(x - 1 / this.camera.zoom, y, radius * .44, -.8, 2.45); context.stroke(); context.restore();
  }

  private drawConnectionLabel(context: CanvasRenderingContext2D, element: Extract<PageElement, { type: "text" }>): void {
    const box = elementBounds(element); const padX = 8; const padY = 5; const radius = 9;
    const x = box.minX - padX; const y = box.minY - padY; const width = box.maxX - box.minX + padX * 2; const height = box.maxY - box.minY + padY * 2;
    context.save(); context.fillStyle = "rgba(255,255,255,.98)"; context.strokeStyle = "rgba(8,8,8,.16)"; context.lineWidth = 1 / this.camera.zoom;
    context.shadowColor = "rgba(8,8,8,.08)"; context.shadowBlur = 10 / this.camera.zoom; context.beginPath(); context.roundRect(x, y, width, height, radius); context.fill();
    context.shadowColor = "transparent"; context.stroke(); context.restore();
  }

  private drawSelection(context: CanvasRenderingContext2D): void {
    const box = this.selectionBounds(); if (!box) return; const pad = 7 / this.camera.zoom; const handle = 7 / this.camera.zoom;
    context.save(); context.strokeStyle = "#000000"; context.lineWidth = 1.5 / this.camera.zoom; context.setLineDash([5 / this.camera.zoom, 4 / this.camera.zoom]);
    context.strokeRect(box.minX - pad, box.minY - pad, box.maxX - box.minX + pad * 2, box.maxY - box.minY + pad * 2); context.setLineDash([]);
    const midX = (box.minX + box.maxX) / 2; const midY = (box.minY + box.maxY) / 2;
    context.fillStyle = "#ffffff"; context.strokeStyle = "#000000";
    for (const [x, y] of [[box.minX, box.minY], [midX, box.minY], [box.maxX, box.minY], [box.maxX, midY], [box.maxX, box.maxY], [midX, box.maxY], [box.minX, box.maxY], [box.minX, midY]]) {
      context.beginPath(); context.arc(x, y, handle / 2, 0, Math.PI * 2); context.fill(); context.stroke();
    }
    context.restore();
  }

  private drawLasso(context: CanvasRenderingContext2D): void {
    if (this.lasso.length < 2) return; context.save(); context.strokeStyle = "#404040"; context.lineWidth = 1.5 / this.camera.zoom;
    context.setLineDash([6 / this.camera.zoom, 5 / this.camera.zoom]); context.beginPath(); context.moveTo(this.lasso[0].x, this.lasso[0].y);
    for (const point of this.lasso.slice(1)) context.lineTo(point.x, point.y); context.stroke(); context.restore();
  }
}
