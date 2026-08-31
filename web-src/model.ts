import { PageElement, ShapeElement, TextElement, boundsForElements, elementBounds } from "../src/document";
import { InkPoint } from "../src/strokes";

export interface Camera { x: number; y: number; zoom: number }
export interface CollaborationRequest {
  id: string;
  instruction: string;
  selectionIds: string[];
  createdAt: string;
  state: "ready" | "working" | "answered";
}
export interface WhiteboardDocument {
  version: 1;
  revision: number;
  elements: PageElement[];
  agentElementIds: string[];
  request: CollaborationRequest | null;
}

export type BoardTool = "select" | "hand" | "pen" | "rectangle" | "ellipse" | "arrow" | "text" | "image" | "lasso" | "eraser";

export type CanvasOperation =
  | { type: "create_text"; id?: string; x: number; y: number; text: string; fontSize?: number; width?: number }
  | { type: "create_shape"; id?: string; kind: "rectangle" | "ellipse"; x: number; y: number; width: number; height: number; filled?: boolean }
  | { type: "create_arrow"; id?: string; from: { x: number; y: number }; to: { x: number; y: number } }
  | { type: "create_stroke"; id?: string; points: InkPoint[]; size?: number }
  | { type: "translate"; ids: string[]; dx: number; dy: number }
  | { type: "resize"; id: string; x: number; y: number; width: number; height: number }
  | { type: "update_text"; id: string; text: string }
  | { type: "delete"; ids: string[] };

export const emptyBoard = (): WhiteboardDocument => ({ version: 1, revision: 0, elements: [], agentElementIds: [], request: null });

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
    element.width *= sx; element.fontSize *= Math.sqrt(Math.abs(sx * sy));
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

export function operationElement(operation: Extract<CanvasOperation, { type: "create_text" | "create_shape" | "create_arrow" | "create_stroke" }>): PageElement {
  if (operation.type === "create_text") {
    const fontSize = Math.max(12, Math.min(160, operation.fontSize ?? 32));
    return { type: "text", id: operation.id ?? id("text"), x: operation.x, baseline: operation.y + fontSize, width: operation.width ?? Math.max(80, operation.text.length * fontSize * 0.58), fontSize, color: "#000000", text: operation.text } satisfies TextElement;
  }
  if (operation.type === "create_arrow") return { type: "shape", id: operation.id ?? id("arrow"), kind: "arrow", points: [{ ...operation.from, pressure: 0.5 }, { ...operation.to, pressure: 0.5 }], color: "#000000", size: 3, closed: false } satisfies ShapeElement;
  if (operation.type === "create_stroke") return { type: "stroke", id: operation.id ?? id("stroke"), color: "#000000", size: operation.size ?? 3, pressureSensitivity: 0.65, points: operation.points.map((point) => ({ ...point, pressure: point.pressure ?? 0.5 })) };
  return { type: "shape", id: operation.id ?? id("shape"), kind: operation.kind, points: [{ x: operation.x, y: operation.y, pressure: 0.5 }, { x: operation.x + operation.width, y: operation.y + operation.height, pressure: 0.5 }], color: "#000000", size: 3, closed: true, fillColor: "#c0c0c0", fillOpacity: operation.filled ? 0.3 : 0 } satisfies ShapeElement;
}

export function elementSummary(element: PageElement): Record<string, unknown> {
  const bounds = elementBounds(element); const base = { id: element.id, type: element.type, bounds };
  if (element.type === "text") return { ...base, text: element.text, fontSize: element.fontSize };
  if (element.type === "shape") return { ...base, kind: element.kind, points: element.points };
  if (element.type === "stroke") return { ...base, points: element.points, size: element.size };
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
    return pointInPolygon(centre, polygon) || polygon.some((point) => point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY);
  }).map((element) => element.id);
}
