import { PageElement, ShapeElement, TextElement, boundsForElements, elementBounds } from "../src/document";
import { InkPoint } from "../src/strokes";

export interface Camera { x: number; y: number; zoom: number }
export interface CollaborationRequest {
  id: string;
  instruction: string;
  selectionIds: string[];
  createdAt: string;
  state: "ready" | "working" | "answered";
  /** Transient blue AI-pen strokes: visual instruction, never a permanent canvas element. */
  ink?: InkPoint[][];
}
export interface WhiteboardDocument {
  version: 1;
  revision: number;
  elements: PageElement[];
  agentElementIds: string[];
  request: CollaborationRequest | null;
  connections?: Record<string, { fromId: string; toId: string; labelId?: string }>;
  groups?: Record<string, string[]>;
}

export type BoardTool = "select" | "hand" | "pen" | "ai-pen" | "rectangle" | "ellipse" | "arrow" | "text" | "image" | "lasso" | "eraser";

export type CanvasOperation =
  | { type: "create_text"; id?: string; x: number; y: number; text: string; fontSize?: number; width?: number; color?: string; fontFamily?: "sans" | "serif" | "mono" | "handwriting"; fontWeight?: 400 | 500 | 600 | 700; fontStyle?: "normal" | "italic"; textAlign?: "left" | "center" | "right" }
  | { type: "create_highlight"; id?: string; x: number; y: number; width: number; size?: number; color?: string; opacity?: number }
  | { type: "highlight_text"; ids: string[]; color?: string; opacity?: number; padding?: number }
  | { type: "create_shape"; id?: string; kind: "rectangle" | "ellipse"; x: number; y: number; width: number; height: number; filled?: boolean; color?: string; strokeWidth?: number; fillColor?: string; fillOpacity?: number; radius?: number; lineStyle?: "solid" | "dashed" | "dotted" }
  | { type: "create_arrow"; id?: string; from: { x: number; y: number }; to: { x: number; y: number }; color?: string; strokeWidth?: number; arrowHeads?: "end" | "start" | "both"; lineStyle?: "solid" | "dashed" | "dotted" }
  | { type: "create_stroke"; id?: string; points: InkPoint[]; size?: number; color?: string }
  | { type: "create_polygon"; id?: string; points: InkPoint[]; closed?: boolean; color?: string; strokeWidth?: number; fillColor?: string; fillOpacity?: number }
  | { type: "translate"; ids: string[]; dx: number; dy: number }
  | { type: "resize"; id: string; x: number; y: number; width: number; height: number }
  | { type: "update_text"; id: string; text: string }
  | { type: "update_points"; id: string; points: InkPoint[] }
  | { type: "update_style"; ids: string[]; color?: string; strokeWidth?: number; fillColor?: string; fillOpacity?: number; fontSize?: number; radius?: number; opacity?: number; lineStyle?: "solid" | "dashed" | "dotted"; arrowHeads?: "end" | "start" | "both"; fontFamily?: "sans" | "serif" | "mono" | "handwriting"; fontWeight?: 400 | 500 | 600 | 700; fontStyle?: "normal" | "italic"; textAlign?: "left" | "center" | "right" }
  | { type: "reorder"; ids: string[]; direction: "front" | "back" }
  | { type: "connect"; id?: string; fromId: string; toId: string; label?: string; color?: string; strokeWidth?: number }
  | { type: "align"; ids: string[]; alignment: "left" | "center-x" | "right" | "top" | "center-y" | "bottom" }
  | { type: "distribute"; ids: string[]; axis: "horizontal" | "vertical"; gap?: number }
  | { type: "duplicate"; ids: string[]; dx?: number; dy?: number }
  | { type: "group"; ids: string[]; groupId?: string }
  | { type: "ungroup"; groupId?: string; ids?: string[] }
  | { type: "delete"; ids: string[] };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const position = (value: unknown): value is { x: number; y: number } => Boolean(value) && typeof value === "object" && finite((value as { x?: unknown }).x) && finite((value as { y?: unknown }).y);
const optionalFinite = (value: unknown): boolean => value === undefined || finite(value);
const optionalOneOf = (value: unknown, choices: readonly string[]): boolean => value === undefined || choices.includes(String(value));
const optionalNumberOf = (value: unknown, choices: readonly number[]): boolean => value === undefined || (finite(value) && choices.includes(value));

export function isCanvasOperation(value: unknown): value is CanvasOperation {
  if (!value || typeof value !== "object") return false; const operation = value as Record<string, unknown>;
  switch (operation.type) {
    case "create_text": return finite(operation.x) && finite(operation.y) && typeof operation.text === "string" && optionalFinite(operation.fontSize) && optionalFinite(operation.width) && optionalOneOf(operation.fontFamily, ["sans", "serif", "mono", "handwriting"]) && optionalNumberOf(operation.fontWeight, [400, 500, 600, 700]) && optionalOneOf(operation.fontStyle, ["normal", "italic"]) && optionalOneOf(operation.textAlign, ["left", "center", "right"]);
    case "create_highlight": return finite(operation.x) && finite(operation.y) && finite(operation.width) && optionalFinite(operation.size) && optionalFinite(operation.opacity);
    case "highlight_text": return ids(operation.ids) && optionalFinite(operation.opacity) && optionalFinite(operation.padding);
    case "create_shape": return (operation.kind === "rectangle" || operation.kind === "ellipse") && finite(operation.x) && finite(operation.y) && finite(operation.width) && finite(operation.height) && optionalFinite(operation.radius) && optionalFinite(operation.strokeWidth) && optionalFinite(operation.fillOpacity) && optionalOneOf(operation.lineStyle, ["solid", "dashed", "dotted"]);
    case "create_arrow": return position(operation.from) && position(operation.to) && optionalFinite(operation.strokeWidth) && optionalOneOf(operation.arrowHeads, ["end", "start", "both"]) && optionalOneOf(operation.lineStyle, ["solid", "dashed", "dotted"]);
    case "create_stroke": return Array.isArray(operation.points) && operation.points.length > 1 && operation.points.every(position);
    case "create_polygon": return Array.isArray(operation.points) && operation.points.length > 1 && operation.points.every(position);
    case "translate": return ids(operation.ids) && finite(operation.dx) && finite(operation.dy);
    case "resize": return typeof operation.id === "string" && finite(operation.x) && finite(operation.y) && finite(operation.width) && finite(operation.height);
    case "update_text": return typeof operation.id === "string" && typeof operation.text === "string";
    case "update_points": return typeof operation.id === "string" && Array.isArray(operation.points) && operation.points.length > 1 && operation.points.every(position);
    case "update_style": return ids(operation.ids) && optionalFinite(operation.strokeWidth) && optionalFinite(operation.fillOpacity) && optionalFinite(operation.fontSize) && optionalFinite(operation.radius) && optionalFinite(operation.opacity) && optionalOneOf(operation.lineStyle, ["solid", "dashed", "dotted"]) && optionalOneOf(operation.arrowHeads, ["end", "start", "both"]) && optionalOneOf(operation.fontFamily, ["sans", "serif", "mono", "handwriting"]) && optionalNumberOf(operation.fontWeight, [400, 500, 600, 700]) && optionalOneOf(operation.fontStyle, ["normal", "italic"]) && optionalOneOf(operation.textAlign, ["left", "center", "right"]);
    case "reorder": return ids(operation.ids) && (operation.direction === "front" || operation.direction === "back");
    case "connect": return typeof operation.fromId === "string" && typeof operation.toId === "string";
    case "align": return ids(operation.ids) && ["left", "center-x", "right", "top", "center-y", "bottom"].includes(String(operation.alignment));
    case "distribute": return ids(operation.ids) && (operation.axis === "horizontal" || operation.axis === "vertical") && (operation.gap === undefined || finite(operation.gap));
    case "duplicate": return ids(operation.ids) && (operation.dx === undefined || finite(operation.dx)) && (operation.dy === undefined || finite(operation.dy));
    case "group": return ids(operation.ids) && operation.ids.length > 0 && (operation.groupId === undefined || typeof operation.groupId === "string");
    case "ungroup": return typeof operation.groupId === "string" || ids(operation.ids);
    case "delete": return ids(operation.ids);
    default: return false;
  }
}

export const emptyBoard = (): WhiteboardDocument => ({ version: 1, revision: 0, elements: [], agentElementIds: [], request: null, connections: {}, groups: {} });

export function cloneBoard(document: WhiteboardDocument): WhiteboardDocument { return structuredClone(document); }

export function validBoard(value: unknown): value is WhiteboardDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WhiteboardDocument>;
  return candidate.version === 1 && typeof candidate.revision === "number" && Array.isArray(candidate.elements) && Array.isArray(candidate.agentElementIds);
}

export function boardBounds(elements: PageElement[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (elements.length === 0) return null; return boundsForElements(elements);
}

export function translateElement(element: PageElement, dx: number, dy: number): void {
  if (element.type === "stroke" || element.type === "shape") element.points.forEach((point) => { point.x += dx; point.y += dy; });
  else if (element.type === "text") { element.x += dx; element.baseline += dy; }
  else if (element.type === "image") { element.x += dx; element.y += dy; }
  else { element.x1 += dx; element.x2 += dx; element.y += dy; }
}

export function scaleElement(element: PageElement, from: { minX: number; minY: number; maxX: number; maxY: number }, to: { minX: number; minY: number; maxX: number; maxY: number }): void {
  const sourceWidth = Math.max(1, from.maxX - from.minX); const sourceHeight = Math.max(1, from.maxY - from.minY);
  const sx = (to.maxX - to.minX) / sourceWidth; const sy = (to.maxY - to.minY) / sourceHeight;
  const point = (candidate: InkPoint): void => { candidate.x = to.minX + (candidate.x - from.minX) * sx; candidate.y = to.minY + (candidate.y - from.minY) * sy; };
  if (element.type === "stroke" || element.type === "shape") {
    element.points.forEach(point); element.size *= Math.sqrt(Math.abs(sx * sy));
  } else if (element.type === "text") {
    element.x = to.minX + (element.x - from.minX) * sx; element.baseline = to.minY + (element.baseline - from.minY) * sy;
    element.width *= sx; if (element.height !== undefined) element.height *= sy; element.fontSize *= Math.sqrt(Math.abs(sx * sy));
  } else if (element.type === "image") {
    element.x = to.minX + (element.x - from.minX) * sx; element.y = to.minY + (element.y - from.minY) * sy;
    element.width *= sx; element.height *= sy;
  } else {
    element.x1 = to.minX + (element.x1 - from.minX) * sx; element.x2 = to.minX + (element.x2 - from.minX) * sx;
    element.y = to.minY + (element.y - from.minY) * sy; element.size *= Math.abs(sy);
  }
}

export function resizeElement(element: PageElement, x: number, y: number, width: number, height: number): void {
  const from = elementBounds(element); scaleElement(element, from, { minX: x, minY: y, maxX: x + Math.max(8, width), maxY: y + Math.max(8, height) });
}

function id(prefix: string): string { return `${prefix}-${crypto.randomUUID()}`; }

export function operationElement(operation: Extract<CanvasOperation, { type: "create_text" | "create_highlight" | "create_shape" | "create_arrow" | "create_stroke" | "create_polygon" }>): PageElement {
  if (operation.type === "create_text") {
    const fontSize = Math.max(12, Math.min(160, operation.fontSize ?? 32));
    const width = operation.width ?? Math.max(80, Math.min(520, operation.text.length * fontSize * 0.58));
    return { type: "text", id: operation.id ?? id("text"), x: operation.x, baseline: operation.y + fontSize, width, height: estimateTextHeight(operation.text, width, fontSize), fontSize, color: operation.color ?? "#000000", text: operation.text, fontFamily: operation.fontFamily, fontWeight: operation.fontWeight, fontStyle: operation.fontStyle, textAlign: operation.textAlign } satisfies TextElement;
  }
  if (operation.type === "create_highlight") return { type: "highlight", id: operation.id ?? id("highlight"), x1: operation.x, x2: operation.x + operation.width, y: operation.y, size: operation.size ?? 28, color: operation.color ?? "#ffd84d", opacity: operation.opacity ?? 0.28 };
  if (operation.type === "create_arrow") return { type: "shape", id: operation.id ?? id("arrow"), kind: "arrow", points: [{ ...operation.from, pressure: 0.5 }, { ...operation.to, pressure: 0.5 }], color: operation.color ?? "#000000", size: operation.strokeWidth ?? 3, closed: false, startArrow: operation.arrowHeads === "start" || operation.arrowHeads === "both", endArrow: operation.arrowHeads !== "start", lineStyle: operation.lineStyle } satisfies ShapeElement;
  if (operation.type === "create_stroke") return { type: "stroke", id: operation.id ?? id("stroke"), color: operation.color ?? "#000000", size: operation.size ?? 3, pressureSensitivity: 0.65, points: operation.points.map((point) => ({ ...point, pressure: point.pressure ?? 0.5 })) };
  if (operation.type === "create_polygon") return { type: "shape", id: operation.id ?? id("polygon"), kind: operation.closed === false ? "line" : "polygon", points: operation.points.map((point) => ({ ...point, pressure: point.pressure ?? 0.5 })), color: operation.color ?? "#000000", size: operation.strokeWidth ?? 3, closed: operation.closed !== false, fillColor: operation.fillColor ?? "#ffffff", fillOpacity: operation.fillOpacity ?? 0 } satisfies ShapeElement;
  return { type: "shape", id: operation.id ?? id("shape"), kind: operation.kind, points: [{ x: operation.x, y: operation.y, pressure: 0.5 }, { x: operation.x + operation.width, y: operation.y + operation.height, pressure: 0.5 }], color: operation.color ?? "#000000", size: operation.strokeWidth ?? 3, closed: true, fillColor: operation.fillColor ?? "#c0c0c0", fillOpacity: operation.fillOpacity ?? (operation.filled ? 0.3 : 0), radius: operation.kind === "rectangle" ? Math.max(0, operation.radius ?? 0) : undefined, lineStyle: operation.lineStyle } satisfies ShapeElement;
}

export function estimateTextHeight(text: string, width: number, fontSize: number): number {
  const approximateCharacters = Math.max(1, Math.floor(width / (fontSize * 0.56)));
  const lines = text.split("\n").reduce((total, paragraph) => total + Math.max(1, Math.ceil(paragraph.length / approximateCharacters)), 0);
  return Math.max(fontSize * 1.2, lines * fontSize * 1.22);
}

export function elementSummary(element: PageElement): Record<string, unknown> {
  const bounds = elementBounds(element); const base = { id: element.id, type: element.type, bounds };
  if (element.type === "text") return { ...base, text: element.text, fontSize: element.fontSize, color: element.color, width: element.width, height: element.height, fontFamily: element.fontFamily ?? "sans", fontWeight: element.fontWeight ?? 400, fontStyle: element.fontStyle ?? "normal", textAlign: element.textAlign ?? "left" };
  if (element.type === "shape") return { ...base, kind: element.kind, points: element.points, color: element.color, strokeWidth: element.size, fillColor: element.fillColor, fillOpacity: element.fillOpacity ?? 0, radius: element.radius ?? 0, lineStyle: element.lineStyle ?? "solid", arrowHeads: element.startArrow ? (element.endArrow === false ? "start" : "both") : "end" };
  if (element.type === "highlight") return { ...base, x1: element.x1, x2: element.x2, y: element.y, size: element.size, color: element.color, opacity: element.opacity };
  if (element.type === "stroke") return { ...base, points: element.points, color: element.color, strokeWidth: element.size };
  if (element.type === "image") return { ...base, sourceName: element.sourceName ?? "image" };
  return base;
}

export function pointInPolygon(point: InkPoint, polygon: InkPoint[]): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const a = polygon[current]; const b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function lassoElements(elements: PageElement[], polygon: InkPoint[]): string[] {
  return elements.filter((element) => {
    const box = elementBounds(element); const centre = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2, pressure: 0.5 };
    const corners = [
      { x: box.minX, y: box.minY, pressure: 0.5 }, { x: box.maxX, y: box.minY, pressure: 0.5 },
      { x: box.maxX, y: box.maxY, pressure: 0.5 }, { x: box.minX, y: box.maxY, pressure: 0.5 }
    ];
    if (pointInPolygon(centre, polygon) || corners.some((point) => pointInPolygon(point, polygon)) || polygon.some((point) => point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY)) return true;
    const elementPoints = element.type === "stroke" || element.type === "shape" ? element.points : corners;
    if (elementPoints.some((point) => pointInPolygon(point, polygon))) return true;
    const edges = corners.map((point, index) => [point, corners[(index + 1) % corners.length]] as const);
    for (let index = 0; index < polygon.length; index += 1) {
      const a = polygon[index]; const b = polygon[(index + 1) % polygon.length];
      if (edges.some(([left, right]) => segmentsIntersect(a, b, left, right))) return true;
      for (let pathIndex = 1; pathIndex < elementPoints.length; pathIndex += 1) if (segmentsIntersect(a, b, elementPoints[pathIndex - 1], elementPoints[pathIndex])) return true;
    }
    return false;
  }).map((element) => element.id);
}

function segmentsIntersect(a: InkPoint, b: InkPoint, c: InkPoint, d: InkPoint): boolean {
  const cross = (left: InkPoint, middle: InkPoint, right: InkPoint): number => (middle.x - left.x) * (right.y - left.y) - (middle.y - left.y) * (right.x - left.x);
  const abC = cross(a, b, c); const abD = cross(a, b, d); const cdA = cross(c, d, a); const cdB = cross(c, d, b);
  const overlaps = Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x))
    && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
  return overlaps && ((abC <= 0 && abD >= 0) || (abC >= 0 && abD <= 0)) && ((cdA <= 0 && cdB >= 0) || (cdA >= 0 && cdB <= 0));
}

export function connectionPoints(from: PageElement, to: PageElement): { from: InkPoint; to: InkPoint } {
  const a = elementBounds(from); const b = elementBounds(to);
  const ac = { x: (a.minX + a.maxX) / 2, y: (a.minY + a.maxY) / 2, pressure: 0.5 };
  const bc = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, pressure: 0.5 };
  const anchor = (box: typeof a, start: InkPoint, target: InkPoint): InkPoint => {
    const dx = target.x - start.x; const dy = target.y - start.y;
    const tx = Math.abs(dx) < 0.001 ? Infinity : (box.maxX - box.minX) / 2 / Math.abs(dx);
    const ty = Math.abs(dy) < 0.001 ? Infinity : (box.maxY - box.minY) / 2 / Math.abs(dy);
    const scale = Math.min(tx, ty); return { x: start.x + dx * scale, y: start.y + dy * scale, pressure: 0.5 };
  };
  return { from: anchor(a, ac, bc), to: anchor(b, bc, ac) };
}
