import { HighlightElement, ImageElement, ShapeElement, StrokeElement, TextElement } from "./document";
import { InkStroke, pressureWidth, visibleInkColor } from "./strokes";

export function drawInkStroke(context: CanvasRenderingContext2D, stroke: InkStroke, laser = false): void {
  if (stroke.points.length === 0) return;
  context.save();
  context.strokeStyle = visibleInkColor(stroke.color);
  context.fillStyle = visibleInkColor(stroke.color);
  context.lineCap = "round";
  context.lineJoin = "round";
  if (laser) { context.globalAlpha = 0.92; context.shadowColor = "#404040"; context.shadowBlur = 18; }
  if (stroke.points.length === 1) {
    const point = stroke.points[0];
    context.beginPath();
    context.arc(point.x, point.y, pressureWidth(stroke, point) / 2, 0, Math.PI * 2);
    context.fill(); context.restore(); return;
  }
  for (let index = 0; index < stroke.points.length - 1; index += 1) {
    const before = stroke.points[index]; const point = stroke.points[index + 1];
    const prior = stroke.points[Math.max(0, index - 1)];
    const start = index === 0 ? before : { x: (prior.x + before.x) / 2, y: (prior.y + before.y) / 2 };
    const end = index === stroke.points.length - 2 ? point : { x: (before.x + point.x) / 2, y: (before.y + point.y) / 2 };
    context.lineWidth = (pressureWidth(stroke, before) + pressureWidth(stroke, point)) / 2;
    context.beginPath(); context.moveTo(start.x, start.y); context.quadraticCurveTo(before.x, before.y, end.x, end.y); context.stroke();
  }
  context.restore();
}

function drawArrowHead(context: CanvasRenderingContext2D, start: { x: number; y: number }, end: { x: number; y: number }, size: number): void {
  const angle = Math.atan2(end.y - start.y, end.x - start.x); const length = Math.max(18, size * 5);
  context.moveTo(end.x, end.y); context.lineTo(end.x - Math.cos(angle - Math.PI / 6) * length, end.y - Math.sin(angle - Math.PI / 6) * length);
  context.moveTo(end.x, end.y); context.lineTo(end.x - Math.cos(angle + Math.PI / 6) * length, end.y - Math.sin(angle + Math.PI / 6) * length);
}

export function drawShape(context: CanvasRenderingContext2D, shape: ShapeElement): void {
  if (shape.points.length === 0) return;
  context.save(); context.strokeStyle = visibleInkColor(shape.color); context.lineWidth = shape.size;
  context.lineCap = shape.kind === "ellipse" || shape.kind === "line" || shape.kind === "arrow" ? "round" : "butt";
  context.lineJoin = shape.kind === "ellipse" ? "round" : "miter"; context.beginPath();
  const first = shape.points[0];
  if (shape.kind === "ellipse") {
    const box = shape.points.reduce((result, point) => ({ minX: Math.min(result.minX, point.x), minY: Math.min(result.minY, point.y), maxX: Math.max(result.maxX, point.x), maxY: Math.max(result.maxY, point.y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    context.ellipse((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, Math.abs(box.maxX - box.minX) / 2, Math.abs(box.maxY - box.minY) / 2, 0, 0, Math.PI * 2);
  } else if (shape.kind === "rectangle" && shape.points.length === 2) {
    const end = shape.points[1]; const x = Math.min(first.x, end.x); const y = Math.min(first.y, end.y); const width = Math.abs(end.x - first.x); const height = Math.abs(end.y - first.y); const radius = Math.max(0, Math.min(shape.radius ?? 0, width / 2, height / 2));
    if (radius > 0) context.roundRect(x, y, width, height, radius); else context.rect(x, y, width, height);
  } else {
    context.moveTo(first.x, first.y); for (const point of shape.points.slice(1)) context.lineTo(point.x, point.y);
    if (shape.closed) context.closePath();
    if (shape.kind === "arrow" && shape.points.length >= 2) drawArrowHead(context, first, shape.points[shape.points.length - 1], shape.size);
  }
  if (shape.closed && shape.fillColor && (shape.fillOpacity ?? 0) > 0) {
    context.save(); context.globalAlpha = shape.fillOpacity ?? 0; context.fillStyle = shape.fillColor; context.fill(); context.restore();
  }
  context.stroke(); context.restore();
}

export function drawHighlight(context: CanvasRenderingContext2D, highlight: HighlightElement): void {
  context.save(); context.globalAlpha = highlight.opacity; context.strokeStyle = highlight.color;
  context.lineWidth = highlight.size; context.lineCap = "round"; context.beginPath();
  context.moveTo(highlight.x1, highlight.y); context.lineTo(highlight.x2, highlight.y); context.stroke(); context.restore();
}

export function drawText(context: CanvasRenderingContext2D, text: TextElement, fontFamily = "ui-sans-serif, system-ui, sans-serif"): void {
  context.save(); context.fillStyle = visibleInkColor(text.color); context.font = `${text.fontSize}px ${fontFamily}`;
  context.textBaseline = "alphabetic";
  const lines: string[] = [];
  for (const paragraph of text.text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean); let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > text.width) { lines.push(line); line = word; }
      else line = candidate;
    }
    lines.push(line);
  }
  const lineHeight = text.fontSize * 1.22;
  for (const [index, line] of lines.entries()) context.fillText(line, text.x, text.baseline + index * lineHeight);
  context.restore();
}

export function drawBoardElement(context: CanvasRenderingContext2D, element: StrokeElement | ShapeElement | HighlightElement | TextElement, fontFamily?: string): void {
  if (element.type === "stroke") drawInkStroke(context, element);
  else if (element.type === "shape") drawShape(context, element);
  else if (element.type === "highlight") drawHighlight(context, element);
  else drawText(context, element, fontFamily);
}

export const imageCache = new Map<string, HTMLImageElement>();

export function cachedImage(element: ImageElement, onload?: () => void): HTMLImageElement {
  const existing = imageCache.get(element.dataUrl); if (existing) return existing;
  const image = new Image(); imageCache.set(element.dataUrl, image);
  if (onload) image.addEventListener("load", onload, { once: true }); image.src = element.dataUrl; return image;
}
