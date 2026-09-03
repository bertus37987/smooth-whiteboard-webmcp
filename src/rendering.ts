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

/* ---------------------------------------------------------------- *
 * Hand-drawn geometry. Deterministic per element id, so the same shape *
 * looks identical on every frame, in PNG and in SVG.                   *
 * ---------------------------------------------------------------- */

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = (seed || 1) >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

function outlineBox(points: Array<{ x: number; y: number }>): { minX: number; minY: number; maxX: number; maxY: number } {
  return points.reduce((box, point) => ({ minX: Math.min(box.minX, point.x), minY: Math.min(box.minY, point.y), maxX: Math.max(box.maxX, point.x), maxY: Math.max(box.maxY, point.y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

/** The shape as an explicit outline: rounded rectangles and ellipses become point paths. */
export function shapeOutline(shape: ShapeElement, cornerSamples = 6): Array<{ x: number; y: number }> {
  if (shape.kind === "ellipse") {
    const box = outlineBox(shape.points); const cx = (box.minX + box.maxX) / 2; const cy = (box.minY + box.maxY) / 2; const rx = (box.maxX - box.minX) / 2; const ry = (box.maxY - box.minY) / 2;
    return Array.from({ length: 56 }, (_, index) => { const angle = index / 56 * Math.PI * 2; return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry }; });
  }
  if (shape.kind === "rectangle" && shape.points.length === 2) {
    const box = outlineBox(shape.points); const width = box.maxX - box.minX; const height = box.maxY - box.minY;
    const corner = Math.max(0, Math.min(shape.radius ?? 0, width / 2, height / 2));
    const corners: Array<[number, number, number]> = [[box.maxX - corner, box.minY + corner, -Math.PI / 2], [box.maxX - corner, box.maxY - corner, 0], [box.minX + corner, box.maxY - corner, Math.PI / 2], [box.minX + corner, box.minY + corner, Math.PI]];
    const outline: Array<{ x: number; y: number }> = [];
    for (const [cx, cy, start] of corners) {
      if (corner <= 0.5) { outline.push({ x: cx, y: cy }); continue; }
      for (let sample = 0; sample <= cornerSamples; sample += 1) { const angle = start + sample / cornerSamples * (Math.PI / 2); outline.push({ x: cx + Math.cos(angle) * corner, y: cy + Math.sin(angle) * corner }); }
    }
    return outline;
  }
  return shape.points.map((point) => ({ x: point.x, y: point.y }));
}

const OUTLINE_SPACING = 26;

function resampleOutline(points: Array<{ x: number; y: number }>, closed: boolean, spacing = OUTLINE_SPACING): Array<{ x: number; y: number }> {
  if (points.length < 2) return points;
  const path = closed ? [...points, points[0]] : points;
  const output: Array<{ x: number; y: number }> = [path[0]];
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1]; const to = path[index];
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.round(distance / spacing));
    for (let step = 1; step <= steps; step += 1) output.push({ x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps });
  }
  if (closed) output.pop();
  return output;
}

export function isSketchShape(shape: ShapeElement): boolean {
  return shape.renderStyle === "sketch" && shape.kind !== "arrow" && shape.kind !== "line";
}

export function sketchShapeClosed(shape: ShapeElement): boolean {
  return shape.kind === "rectangle" || shape.kind === "ellipse" || shape.closed !== false;
}

/**
 * One hand-drawn pass over a shape: a slow wobble along the outline rather than per-point noise,
 * seeded from the element id so it never shimmers between frames or export formats.
 */
export function sketchOutline(shape: ShapeElement, pass = 0): Array<{ x: number; y: number }> {
  const outline = resampleOutline(shapeOutline(shape), sketchShapeClosed(shape));
  if (outline.length < 2) return outline;
  const random = seededRandom(hashString(`${shape.id}:${pass}`));
  const amount = Math.min(4, Math.max(1.8, shape.size * .8));
  const phaseX = random() * Math.PI * 2; const phaseY = random() * Math.PI * 2;
  // One wave roughly every 110 world units, so a single card edge visibly bends instead of tilting.
  const frequency = Math.max(2, outline.length * OUTLINE_SPACING / 110) * (.85 + random() * .3);
  const driftX = (random() - .5) * amount; const driftY = (random() - .5) * amount;
  return outline.map((point, index) => {
    const t = index / outline.length * Math.PI * 2 * frequency;
    return { x: point.x + Math.sin(t + phaseX) * amount + driftX, y: point.y + Math.cos(t * 1.13 + phaseY) * amount + driftY };
  });
}

function tracePath(context: CanvasRenderingContext2D, points: Array<{ x: number; y: number }>, closed: boolean): void {
  context.beginPath(); context.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) context.lineTo(point.x, point.y);
  if (closed) context.closePath();
}

function drawSketchShape(context: CanvasRenderingContext2D, shape: ShapeElement): void {
  const closed = sketchShapeClosed(shape); const first = sketchOutline(shape, 0); if (first.length < 2) return;
  context.save();
  context.strokeStyle = visibleInkColor(shape.color); context.lineWidth = shape.size; context.lineCap = "round"; context.lineJoin = "round";
  if (shape.lineStyle === "dashed") context.setLineDash([shape.size * 3.5, shape.size * 2.5]);
  else if (shape.lineStyle === "dotted") context.setLineDash([0.01, shape.size * 2.8]);
  if (closed && shape.fillColor && (shape.fillOpacity ?? 0) > 0) {
    tracePath(context, first, true); context.save(); context.globalAlpha *= shape.fillOpacity ?? 0; context.fillStyle = shape.fillColor; context.fill(); context.restore();
  }
  tracePath(context, first, closed); context.stroke();
  const second = sketchOutline(shape, 1);
  context.globalAlpha *= .5; context.lineWidth = Math.max(.6, shape.size * .75);
  tracePath(context, second, closed); context.stroke();
  context.restore();
}

/** The two barbs of an arrow head, shared by the canvas renderer and the SVG exporter. */
export function arrowHeadPoints(start: { x: number; y: number }, end: { x: number; y: number }, size: number): { left: { x: number; y: number }; right: { x: number; y: number } } {
  const angle = Math.atan2(end.y - start.y, end.x - start.x); const length = Math.max(18, size * 5);
  return {
    left: { x: end.x - Math.cos(angle - Math.PI / 6) * length, y: end.y - Math.sin(angle - Math.PI / 6) * length },
    right: { x: end.x - Math.cos(angle + Math.PI / 6) * length, y: end.y - Math.sin(angle + Math.PI / 6) * length }
  };
}

function drawArrowHead(context: CanvasRenderingContext2D, start: { x: number; y: number }, end: { x: number; y: number }, size: number): void {
  const barbs = arrowHeadPoints(start, end, size);
  context.moveTo(end.x, end.y); context.lineTo(barbs.left.x, barbs.left.y);
  context.moveTo(end.x, end.y); context.lineTo(barbs.right.x, barbs.right.y);
}

export function drawShape(context: CanvasRenderingContext2D, shape: ShapeElement): void {
  if (shape.points.length === 0) return;
  if (isSketchShape(shape)) { drawSketchShape(context, shape); return; }
  context.save(); context.strokeStyle = visibleInkColor(shape.color); context.lineWidth = shape.size;
  context.lineCap = shape.kind === "ellipse" || shape.kind === "line" || shape.kind === "arrow" ? "round" : "butt";
  context.lineJoin = shape.kind === "ellipse" ? "round" : "miter";
  if (shape.lineStyle === "dashed") context.setLineDash([shape.size * 3.5, shape.size * 2.5]);
  else if (shape.lineStyle === "dotted") { context.setLineDash([0.01, shape.size * 2.8]); context.lineCap = "round"; }
  context.beginPath();
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
    if (shape.kind === "arrow" && shape.points.length >= 2) {
      const last = shape.points[shape.points.length - 1];
      if (shape.startArrow) drawArrowHead(context, last, first, shape.size);
      if (shape.endArrow !== false) drawArrowHead(context, first, last, shape.size);
    }
  }
  if (shape.closed && shape.fillColor && (shape.fillOpacity ?? 0) > 0) {
    context.save(); context.globalAlpha = shape.fillOpacity ?? 0; context.fillStyle = shape.fillColor; context.fill(); context.restore();
  }
  context.stroke(); context.restore();
}

export function drawHighlight(context: CanvasRenderingContext2D, highlight: HighlightElement): void {
  context.save(); context.globalAlpha = highlight.opacity; context.strokeStyle = highlight.color;
  context.lineWidth = highlight.size; context.lineCap = "round"; context.beginPath();
  const points = highlight.points;
  if (points?.length) {
    context.lineJoin = "round"; context.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length - 1; index += 1) {
      const point = points[index]; const next = points[index + 1];
      context.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
    }
    const last = points.at(-1)!; context.lineTo(last.x, last.y);
  } else { context.moveTo(highlight.x1, highlight.y); context.lineTo(highlight.x2, highlight.y); }
  context.stroke(); context.restore();
}

export const textFontFamilies = {
  sans: '"Inter", ui-sans-serif, system-ui, sans-serif',
  serif: "Georgia, Cambria, serif",
  mono: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  handwriting: '"Caveat", "Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive, sans-serif'
} as const;

/** The bundled faces, in the form document.fonts.load() wants. */
export const bundledFontFaces = ['400 16px "Inter"', '700 16px "Inter"', '400 16px "Caveat"', '700 16px "Caveat"'] as const;
export const TEXT_LINE_HEIGHT = 1.22;

export type TextMetricsInput = Pick<TextElement, "fontSize" | "fontFamily" | "fontWeight" | "fontStyle" | "blockStyle">;

export function textFontString(text: TextMetricsInput, family?: string): string {
  const weight = text.fontWeight ?? (text.blockStyle?.startsWith("heading") ? 700 : 400);
  return `${text.fontStyle ?? "normal"} ${weight} ${text.fontSize}px ${family ?? textFontFamilies[text.fontFamily ?? "sans"]}`;
}

/**
 * The one wrapping implementation. The renderer measures with the canvas, the layout code measures
 * with an offscreen canvas of the same font, so predicted and painted line counts cannot drift apart.
 */
export function wrapTextLines(text: string, width: number, blockStyle: TextElement["blockStyle"] | undefined, measure: (line: string) => number): string[] {
  const lines: string[] = [];
  const marker = (index: number): string => blockStyle === "bullet" ? "• " : blockStyle === "numbered" ? `${index + 1}. ` : blockStyle === "check" ? "☐ " : blockStyle === "quote" ? "› " : "";
  for (const [index, paragraph] of text.split("\n").entries()) {
    const prefix = marker(index);
    // Wrapped list lines keep the marker's width, so they hang under the text and not under the bullet.
    const indent = " ".repeat(prefix.length);
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = prefix; let started = false;
    for (const word of words) {
      const candidate = started ? `${line} ${word}` : `${line}${word}`;
      if (started && measure(candidate) > width) { lines.push(line); line = `${indent}${word}`; }
      else line = candidate;
      started = true;
    }
    lines.push(line);
  }
  return lines;
}

export function drawText(context: CanvasRenderingContext2D, text: TextElement, fontFamily?: string): void {
  const family = fontFamily ?? textFontFamilies[text.fontFamily ?? "sans"];
  if (text.renderStyle === "sketch") { context.save(); context.globalAlpha *= .18; context.translate(.9, -.55); drawText(context, { ...text, renderStyle: "clean" }, family); context.restore(); }
  context.save(); context.fillStyle = text.onFilledSurface ? text.color : visibleInkColor(text.color); context.font = textFontString(text, family);
  context.textBaseline = "alphabetic";
  context.textAlign = text.textAlign ?? "left";
  const lines = wrapTextLines(text.text, text.width, text.blockStyle, (line) => context.measureText(line).width);
  const lineHeight = text.fontSize * TEXT_LINE_HEIGHT;
  const anchorX = text.textAlign === "center" ? text.x + text.width / 2 : text.textAlign === "right" ? text.x + text.width : text.x;
  if (text.highlightColor) {
    context.save(); context.globalAlpha = 0.24; context.fillStyle = text.highlightColor;
    for (const [index, line] of lines.entries()) { const metrics = context.measureText(line); const left = text.textAlign === "center" ? anchorX - metrics.width / 2 : text.textAlign === "right" ? anchorX - metrics.width : anchorX; context.fillRect(left - 4, text.baseline + index * lineHeight - text.fontSize, metrics.width + 8, text.fontSize * 1.18); }
    context.restore(); context.fillStyle = visibleInkColor(text.color);
  }
  for (const [index, line] of lines.entries()) {
    const baseline = text.baseline + index * lineHeight; context.fillText(line, anchorX, baseline);
    if (text.textDecoration && text.textDecoration !== "none") {
      const metrics = context.measureText(line); const left = text.textAlign === "center" ? anchorX - metrics.width / 2 : text.textAlign === "right" ? anchorX - metrics.width : anchorX;
      const y = text.textDecoration === "line-through" ? baseline - text.fontSize * .32 : baseline + text.fontSize * .09;
      context.save(); context.strokeStyle = visibleInkColor(text.color); context.lineWidth = Math.max(1, text.fontSize * .055); context.beginPath(); context.moveTo(left, y); context.lineTo(left + metrics.width, y); context.stroke(); context.restore();
    }
  }
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
