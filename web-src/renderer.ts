import { PageElement, elementBounds } from "../src/document";
import { InkPoint } from "../src/strokes";
import { cachedImage, drawBoardElement } from "../src/rendering";
import { Camera, boardBounds } from "./model";

export class BoardRenderer {
  readonly camera: Camera = { x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 };
  selectionIds = new Set<string>();
  lasso: InkPoint[] = [];
  activeAgentIds = new Set<string>();
  private frame = 0;
  private resizeObserver: ResizeObserver;

  constructor(readonly canvas: HTMLCanvasElement, private readonly elements: () => PageElement[]) {
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

  onResizeHandle(point: InkPoint): boolean {
    const bounds = this.selectionBounds(); if (!bounds) return false; const radius = 14 / this.camera.zoom;
    return Math.hypot(point.x - bounds.maxX, point.y - bounds.maxY) <= radius;
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
    for (const element of this.elements()) {
      if (element.type === "image") {
        const image = cachedImage(element, () => this.request()); if (image.complete && image.naturalWidth > 0) context.drawImage(image, element.x, element.y, element.width, element.height);
      } else drawBoardElement(context, element);
      if (this.activeAgentIds.has(element.id)) this.drawAgentHalo(context, element);
    }
    this.drawSelection(context); this.drawLasso(context); context.restore();
  }

  private drawAgentHalo(context: CanvasRenderingContext2D, element: PageElement): void {
    const box = elementBounds(element); const pad = 8 / this.camera.zoom;
    context.save(); context.strokeStyle = "#808080"; context.globalAlpha = 0.7; context.lineWidth = 2 / this.camera.zoom;
    context.setLineDash([6 / this.camera.zoom, 5 / this.camera.zoom]); context.strokeRect(box.minX - pad, box.minY - pad, box.maxX - box.minX + pad * 2, box.maxY - box.minY + pad * 2); context.restore();
  }

  private drawSelection(context: CanvasRenderingContext2D): void {
    const box = this.selectionBounds(); if (!box) return; const pad = 7 / this.camera.zoom; const handle = 9 / this.camera.zoom;
    context.save(); context.strokeStyle = "#000000"; context.lineWidth = 1.5 / this.camera.zoom; context.setLineDash([5 / this.camera.zoom, 4 / this.camera.zoom]);
    context.strokeRect(box.minX - pad, box.minY - pad, box.maxX - box.minX + pad * 2, box.maxY - box.minY + pad * 2); context.setLineDash([]);
    context.fillStyle = "#ffffff"; context.strokeStyle = "#000000"; context.fillRect(box.maxX - handle / 2, box.maxY - handle / 2, handle, handle); context.strokeRect(box.maxX - handle / 2, box.maxY - handle / 2, handle, handle); context.restore();
  }

  private drawLasso(context: CanvasRenderingContext2D): void {
    if (this.lasso.length < 2) return; context.save(); context.strokeStyle = "#404040"; context.lineWidth = 1.5 / this.camera.zoom;
    context.setLineDash([6 / this.camera.zoom, 5 / this.camera.zoom]); context.beginPath(); context.moveTo(this.lasso[0].x, this.lasso[0].y);
    for (const point of this.lasso.slice(1)) context.lineTo(point.x, point.y); context.stroke(); context.restore();
  }
}
