import { InkPoint, InkStroke } from "./strokes";

export type Paper = "grid" | "lines" | "blank";
export type ShapeKind = "line" | "arrow" | "ellipse" | "rectangle" | "polygon";

export interface ElementMeta {
  locked?: boolean;
  opacity?: number;
  /** Human-readable layer name used by artboards and agent inspection. */
  name?: string;
  /** Optional containing artboard or semantic frame. */
  parentId?: string;
  semanticRole?: string;
  renderStyle?: "clean" | "sketch";
  /** Lightweight artboard metadata. Artboards stay ordinary editable shapes. */
  artboard?: {
    preset: "desktop" | "tablet" | "mobile" | "custom";
    backgroundColor: string;
    clipContent?: boolean;
  };
  /** Optional references to source cards used by visual explanations. */
  sourceRefs?: string[];
  /** One-shot human context marker included in the next agent turn. */
  agentAttached?: boolean;
}

export interface StrokeElement extends InkStroke, ElementMeta {
  type: "stroke";
  /** Optional local English handwriting transcription; never replaces the visible ink. */
  recognitionText?: string;
}

export interface TextElement extends ElementMeta {
  type: "text";
  id: string;
  x: number;
  baseline: number;
  width: number;
  /** Custom text-box height. Older documents derive it from fontSize. */
  height?: number;
  /**
   * This label sits on a filled shape, so its colour is used as given. Without it the guard that
   * keeps near-white ink from vanishing on the white page turns light type on a dark bar dark too.
   */
  onFilledSurface?: boolean;
  fontSize: number;
  color: string;
  text: string;
  /** Curated, portable font roles used by both the human UI and WebMCP agent. */
  fontFamily?: "sans" | "serif" | "mono" | "handwriting";
  fontWeight?: 400 | 500 | 600 | 700;
  fontStyle?: "normal" | "italic";
  textDecoration?: "none" | "underline" | "line-through";
  textAlign?: "left" | "center" | "right";
  blockStyle?: "body" | "heading-1" | "heading-2" | "heading-3" | "bullet" | "numbered" | "check" | "quote" | "code" | "math";
  highlightColor?: string;
}

export interface HighlightElement extends ElementMeta {
  type: "highlight";
  id: string;
  x1: number;
  x2: number;
  y: number;
  size: number;
  color: string;
  opacity: number;
  /** A real marker gesture. Legacy/smart highlights remain a straight x1/x2 line. */
  points?: InkPoint[];
}

export interface ShapeElement extends ElementMeta {
  type: "shape";
  id: string;
  kind: ShapeKind;
  points: InkPoint[];
  color: string;
  size: number;
  closed: boolean;
  fillColor?: string;
  fillOpacity?: number;
  /** Optional editable corner radius for rectangular UI and diagram shapes. */
  radius?: number;
  lineStyle?: "solid" | "dashed" | "dotted";
  startArrow?: boolean;
  endArrow?: boolean;
}

export interface ImageElement extends ElementMeta {
  type: "image";
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  dataUrl: string;
  mimeType: "image/png" | "image/jpeg";
  sourceName?: string;
}

export type PageElement = StrokeElement | TextElement | HighlightElement | ShapeElement | ImageElement;

export interface HandwritingPage {
  id: string;
  width: number;
  height: number;
  paper: Paper;
  elements: PageElement[];
  /** Learned writing rows. New words near one of these baselines snap to it. */
  baselines?: number[];
}

export interface HandwritingProfile {
  targetHeight: number;
  samples: number;
  averageSlope: number;
}

export interface HandwritingDocumentV3 {
  version: 3;
  pages: HandwritingPage[];
  profile: HandwritingProfile;
}

export type HandwritingDocumentV2 = HandwritingDocumentV3;

interface StoredDocumentV2 {
  version: 2;
  pages: HandwritingPage[];
}

interface LegacyText {
  id: string;
  x: number;
  baseline: number;
  width: number;
  fontSize: number;
  color: string;
  text: string;
}

interface LegacyDocumentV1 {
  version: 1;
  width: number;
  height: number;
  paper: Paper;
  strokes: InkStroke[];
  texts?: LegacyText[];
}

export const A4_WIDTH = 1200;
export const A4_HEIGHT = Math.round(A4_WIDTH * 297 / 210);

export function createPage(paper: Paper, width = A4_WIDTH, height = Math.round(width * 297 / 210)): HandwritingPage {
  return { id: crypto.randomUUID(), width, height, paper, elements: [], baselines: [] };
}

export function createDocument(paper: Paper): HandwritingDocumentV3 {
  return { version: 3, pages: [createPage(paper)], profile: { targetHeight: 52, samples: 0, averageSlope: 0 } };
}

export function paperBaselineStep(paper: Paper): number {
  return paper === "grid" ? 24 : paper === "lines" ? 32 : 0;
}

export function alignPageBaselines(page: HandwritingPage): boolean {
  const original = Array.isArray(page.baselines) ? page.baselines : [];
  const step = paperBaselineStep(page.paper);
  const aligned = [...new Set(original
    .filter((baseline) => Number.isFinite(baseline) && baseline > 0 && baseline < page.height)
    .map((baseline) => step > 0 ? Math.round(baseline / step) * step : baseline))]
    .sort((left, right) => left - right);
  const changed = !Array.isArray(page.baselines) || JSON.stringify(original) !== JSON.stringify(aligned);
  page.baselines = aligned;
  return changed;
}

function pointDistance(left: InkPoint, right: InkPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

/**
 * Turns a consecutively drawn, connected run of 3–12 straight segments into
 * one closed sharp polygon. This supports natural pen-lift-at-each-corner
 * drawing without a separate polygon selection tool.
 */
export function mergeClosedLineShapes(page: HandwritingPage, fillColor?: string, fillOpacity?: number): boolean {
  let changed = false;
  let index = 0;
  while (index < page.elements.length) {
    const first = page.elements[index];
    if (first.type !== "shape" || first.kind !== "line" || first.points.length < 2) { index += 1; continue; }
    const firstStart = first.points[0];
    let currentEnd = first.points[first.points.length - 1];
    const vertices: InkPoint[] = [{ ...firstStart }, { ...currentEnd }];
    const segments: ShapeElement[] = [first];
    let cursor = index + 1;
    for (; cursor < page.elements.length && segments.length < 12; cursor += 1) {
      const candidate = page.elements[cursor];
      if (candidate.type !== "shape" || candidate.kind !== "line" || candidate.points.length < 2) break;
      const start = candidate.points[0];
      const end = candidate.points[candidate.points.length - 1];
      const toStart = pointDistance(currentEnd, start);
      const toEnd = pointDistance(currentEnd, end);
      if (Math.min(toStart, toEnd) > 34) break;
      currentEnd = toStart <= toEnd ? end : start;
      vertices.push({ ...currentEnd });
      segments.push(candidate);
      if (segments.length >= 3 && pointDistance(currentEnd, firstStart) <= 34) {
        const cleanVertices = vertices.slice(0, -1);
        if (cleanVertices.length >= 3) {
          const polygon: ShapeElement = {
            type: "shape",
            id: segments[segments.length - 1].id,
            kind: "polygon",
            points: cleanVertices,
            color: segments[0].color,
            size: segments.reduce((sum, segment) => sum + segment.size, 0) / segments.length,
            closed: true,
            fillColor,
            fillOpacity: fillOpacity ?? 0
          };
          page.elements.splice(index, segments.length, polygon);
          changed = true;
        }
        break;
      }
    }
    index += 1;
  }
  return changed;
}

function preparePages(pages: HandwritingPage[]): boolean {
  let changed = false;
  for (const page of pages) {
    const a4Height = Math.round(page.width * 297 / 210);
    if (page.height !== a4Height) { page.height = a4Height; changed = true; }
    if (alignPageBaselines(page)) changed = true;
    if (mergeClosedLineShapes(page)) changed = true;
  }
  return changed;
}

function isPaper(value: unknown): value is Paper {
  return value === "grid" || value === "lines" || value === "blank";
}

function isLegacyDocument(value: unknown): value is LegacyDocumentV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LegacyDocumentV1>;
  return candidate.version === 1
    && typeof candidate.width === "number"
    && typeof candidate.height === "number"
    && isPaper(candidate.paper)
    && Array.isArray(candidate.strokes);
}

function hasValidPages(value: unknown): value is { pages: HandwritingPage[] } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredDocumentV2>;
  return Array.isArray(candidate.pages) && candidate.pages.length > 0
    && candidate.pages.every((page) => page
      && typeof page.id === "string"
      && typeof page.width === "number"
      && typeof page.height === "number"
      && isPaper(page.paper)
      && Array.isArray(page.elements));
}

export function parseDocument(value: unknown): { document: HandwritingDocumentV3; migrated: boolean } | null {
  if (hasValidPages(value) && (value as { version?: number }).version === 3) {
    const candidate = value as HandwritingDocumentV3;
    const pagesChanged = preparePages(candidate.pages);
    if (candidate.profile && typeof candidate.profile.targetHeight === "number") return { document: candidate, migrated: pagesChanged };
    return { document: { ...candidate, profile: { targetHeight: 52, samples: 0, averageSlope: 0 } }, migrated: true };
  }
  if (hasValidPages(value) && (value as { version?: number }).version === 2) {
    const pages = (value as StoredDocumentV2).pages;
    preparePages(pages);
    return {
      migrated: true,
      document: { version: 3, pages, profile: { targetHeight: 52, samples: 0, averageSlope: 0 } }
    };
  }
  if (!isLegacyDocument(value)) return null;
  const elements: PageElement[] = [
    ...value.strokes.map((stroke): StrokeElement => ({ ...stroke, type: "stroke" })),
    ...(value.texts ?? []).map((text): TextElement => ({ ...text, type: "text" }))
  ];
  return {
    migrated: true,
    document: {
      version: 3,
      profile: { targetHeight: 52, samples: 0, averageSlope: 0 },
      pages: [{
        id: crypto.randomUUID(),
        width: value.width,
        height: Math.round(value.width * 297 / 210),
        paper: value.paper,
        elements,
        baselines: []
      }]
    }
  };
}

export function cloneDocument(document: HandwritingDocumentV3): HandwritingDocumentV3 {
  return structuredClone(document);
}

export function elementBounds(element: PageElement): { minX: number; minY: number; maxX: number; maxY: number } {
  if (element.type === "image") {
    return { minX: element.x, minY: element.y, maxX: element.x + element.width, maxY: element.y + element.height };
  }
  if (element.type === "text") {
    const height = element.height ?? element.fontSize * 1.2;
    return {
      minX: element.x,
      minY: element.baseline - element.fontSize,
      maxX: element.x + element.width,
      maxY: element.baseline - element.fontSize + height
    };
  }
  if (element.type === "highlight") {
    if (element.points?.length) {
      const bounds = element.points.reduce((box, point) => ({
        minX: Math.min(box.minX, point.x), minY: Math.min(box.minY, point.y),
        maxX: Math.max(box.maxX, point.x), maxY: Math.max(box.maxY, point.y)
      }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
      return { minX: bounds.minX - element.size / 2, minY: bounds.minY - element.size / 2, maxX: bounds.maxX + element.size / 2, maxY: bounds.maxY + element.size / 2 };
    }
    return {
      minX: Math.min(element.x1, element.x2),
      minY: element.y - element.size / 2,
      maxX: Math.max(element.x1, element.x2),
      maxY: element.y + element.size / 2
    };
  }
  const points = element.points;
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return points.reduce((box, point) => ({
    minX: Math.min(box.minX, point.x),
    minY: Math.min(box.minY, point.y),
    maxX: Math.max(box.maxX, point.x),
    maxY: Math.max(box.maxY, point.y)
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

export function boundsForElements(elements: PageElement[]): { minX: number; minY: number; maxX: number; maxY: number } {
  return elements.reduce((box, element) => {
    const bounds = elementBounds(element);
    return {
      minX: Math.min(box.minX, bounds.minX),
      minY: Math.min(box.minY, bounds.minY),
      maxX: Math.max(box.maxX, bounds.maxX),
      maxY: Math.max(box.maxY, bounds.maxY)
    };
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}
