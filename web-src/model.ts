import { PageElement, ShapeElement, TextElement, boundsForElements, elementBounds } from "../src/document";
import { InkPoint } from "../src/strokes";
import { TextMetricsInput } from "../src/rendering";
import { measuredTextHeight } from "./measure";
import { fitSubpaths, parseSvgPath } from "./path";

export interface Camera { x: number; y: number; zoom: number }
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }
export interface WhiteboardSettings {
  inputSmoothing: boolean;
  pressure: boolean;
  autoShape: boolean;
  smartHighlight: boolean;
  englishHandwritingAssist: boolean;
  /** Take the agent's proposals straight onto the board; Ctrl+Z still takes one back whole. */
  autoAcceptAgent: boolean;
  /** Draw the agent's work in plain type and straight lines instead of the hand-drawn look. */
  cleanStyle: boolean;
}
export interface PriorityRegion {
  source: "ai-pen" | "attachment" | "selection" | "highlight" | "recent-edit" | "deleted";
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  elementIds: string[];
  priority: number;
}
export interface AgentMarkerAnnotation {
  id: string;
  kind: "stroke" | "note";
  points?: InkPoint[];
  x?: number;
  y?: number;
  text?: string;
  anchorId?: string;
}
export interface ExplanationStep {
  id: string;
  title: string;
  body?: string;
  focusElementIds: string[];
  revealElementIds: string[];
  cameraBounds?: { minX: number; minY: number; maxX: number; maxY: number };
}
export interface ExplanationSequence { id: string; title: string; steps: ExplanationStep[] }
export type IconName = "check" | "close" | "plus" | "minus" | "menu" | "search" | "user" | "heart" | "arrow" | "star" | "bulb" | "question" | "warning" | "clock"
  | "server" | "database" | "cloud" | "browser" | "mobile" | "lock" | "key" | "file" | "folder" | "gear" | "mail" | "link" | "chart" | "shield" | "globe" | "terminal";
export const iconNames: IconName[] = ["check", "close", "plus", "minus", "menu", "search", "user", "heart", "arrow", "star", "bulb", "question", "warning", "clock",
  "server", "database", "cloud", "browser", "mobile", "lock", "key", "file", "folder", "gear", "mail", "link", "chart", "shield", "globe", "terminal"];
/** How a smart connector travels between two objects. */
export type ConnectorRoute = "straight" | "orthogonal" | "curved";
export interface SourceReference { id: string; title: string; url?: string }
export interface BoardLintIssue {
  code: "text-overflow" | "spills-card" | "off-artboard" | "small-target" | "overlap" | "low-contrast" | "unlabelled-control" | "wordy-card";
  severity: "info" | "warning";
  elementIds: string[];
  message: string;
  suggestedFix: string;
}
export type TurnStatus = "queued" | "claimed" | "planning" | "working" | "review" | "complete" | "cancelled";
/** Session level state: turn statuses plus the two states that exist while no turn is open. */
export type SessionState = TurnStatus | "idle" | "waiting";
export type ContextScope = "all" | "priority" | "selection";
export interface DeletedRegion { elementIds: string[]; bounds: Bounds }
export interface TurnCapabilities {
  state: SessionState;
  canWait: boolean;
  canInspect: boolean;
  canFocus: boolean;
  canWrite: boolean;
  canComplete: boolean;
  hasLease: boolean;
  awaitingHumanDecision: boolean;
  nextAction: string;
  contextScope: ContextScope | null;
}
export interface CollaborationTurn {
  id: string;
  status: TurnStatus;
  submittedRevision: number;
  createdAt: string;
  promptText: string;
  selectionIds: string[];
  instructionInk: InkPoint[][];
  agentMarkers: AgentMarkerAnnotation[];
  priorityRegions: PriorityRegion[];
  changedElementIds: string[];
  pendingChangeIds: string[];
  /** Frozen at submit time: which part of the board the human meant. */
  contextScope?: ContextScope;
  /** Where the human removed content before submitting; ids no longer resolve, the bounds still do. */
  deletedRegions?: DeletedRegion[];
  planSummary?: string;
  /** The sentence the agent finished with; written into the journal once the human keeps the work. */
  completionSummary?: string;
  leaseToken?: string;
}
export interface CollaborationRequest {
  id: string;
  instruction: string;
  selectionIds: string[];
  createdAt: string;
  state: "ready" | "working" | "answered";
  /** Transient blue AI-pen strokes: visual instruction, never a permanent canvas element. */
  ink?: InkPoint[][];
}
/** One accepted contribution, in the words the agent used to finish it. */
export interface JournalEntry { at: string; summary: string; elementIds: string[] }
/** How much of the board's story is worth carrying. */
export const MAX_JOURNAL_ENTRIES = 20;

export interface WhiteboardDocument {
  version: 3;
  revision: number;
  elements: PageElement[];
  agentElementIds: string[];
  request?: CollaborationRequest | null;
  turn: CollaborationTurn | null;
  settings: WhiteboardSettings;
  lastAgentRevision: number;
  connections?: Record<string, { fromId: string; toId: string; labelId?: string; route?: ConnectorRoute }>;
  groups?: Record<string, string[]>;
  artboardIds: string[];
  explanationSequences: ExplanationSequence[];
  sources: SourceReference[];
  /** Which guided-explanation step the human is looking at; survives reloads and can be set by the agent. */
  presentation?: { sequenceId: string; index: number } | null;
  /** Symbols the agent drew and named, as SVG path data in a 0..1 box. Reusable like the built-in ones. */
  symbols?: Record<string, string>;
  /** What was agreed on this board, one line per accepted turn, so a later turn does not start blind. */
  journal?: JournalEntry[];
}

export type BoardTool = "select" | "hand" | "pen" | "ai-pen" | "marker" | "rectangle" | "ellipse" | "arrow" | "text" | "sticky" | "image" | "lasso" | "ai-lasso" | "eraser" | "artboard";

export type CanvasOperation =
  | { type: "create_text"; id?: string; x: number; y: number; text: string; fontSize?: number; width?: number; color?: string; fontFamily?: "sans" | "serif" | "mono" | "handwriting"; fontWeight?: 400 | 500 | 600 | 700; fontStyle?: "normal" | "italic"; textDecoration?: "none" | "underline" | "line-through"; textAlign?: "left" | "center" | "right"; blockStyle?: TextElement["blockStyle"]; highlightColor?: string; renderStyle?: "clean" | "sketch"; semanticRole?: string; parentId?: string; name?: string; sourceRefs?: string[] }
  | { type: "create_note"; id?: string; x: number; y: number; width?: number; height?: number; text: string; color?: string; fillColor?: string; blockStyle?: TextElement["blockStyle"]; renderStyle?: "clean" | "sketch"; parentId?: string }
  | { type: "create_table"; id?: string; x: number; y: number; width: number; height: number; rows: number; columns: number; headers?: string[]; cells?: string[]; color?: string; fillColor?: string; renderStyle?: "clean" | "sketch" }
  | { type: "create_frame"; id?: string; x: number; y: number; width: number; height: number; title?: string; color?: string; backgroundColor?: string; renderStyle?: "clean" | "sketch"; semanticRole?: string; parentId?: string; name?: string; artboardPreset?: "desktop" | "tablet" | "mobile" | "custom"; clipContent?: boolean }
  | { type: "create_highlight"; id?: string; x: number; y: number; width: number; points?: InkPoint[]; size?: number; color?: string; opacity?: number }
  | { type: "highlight_text"; ids: string[]; color?: string; opacity?: number; padding?: number }
  | { type: "create_shape"; id?: string; kind: "rectangle" | "ellipse" | "diamond" | "triangle"; x: number; y: number; width: number; height: number; filled?: boolean; color?: string; strokeWidth?: number; fillColor?: string; fillOpacity?: number; radius?: number; lineStyle?: "solid" | "dashed" | "dotted"; renderStyle?: "clean" | "sketch"; semanticRole?: string; parentId?: string; name?: string }
  | { type: "create_arrow"; id?: string; from: { x: number; y: number }; to: { x: number; y: number }; color?: string; strokeWidth?: number; arrowHeads?: "end" | "start" | "both"; lineStyle?: "solid" | "dashed" | "dotted"; renderStyle?: "clean" | "sketch" }
  | { type: "create_stroke"; id?: string; points: InkPoint[]; size?: number; color?: string }
  | { type: "create_polygon"; id?: string; points: InkPoint[]; closed?: boolean; color?: string; strokeWidth?: number; fillColor?: string; fillOpacity?: number; renderStyle?: "clean" | "sketch" }
  | { type: "create_path"; id?: string; points?: Array<{ x: number; y: number }>; d?: string; x?: number; y?: number; width?: number; height?: number; smooth?: boolean; closed?: boolean; bow?: number; color?: string; strokeWidth?: number; fillColor?: string; fillOpacity?: number; renderStyle?: "clean" | "sketch" }
  | { type: "create_annotation"; id?: string; kind: AnnotationKind; x: number; y: number; width: number; height: number; direction?: "left" | "right" | "up" | "down"; text?: string; anchorId?: string; color?: string; strokeWidth?: number; fontSize?: number; renderStyle?: "clean" | "sketch" }
  | { type: "create_callout"; id?: string; x: number; y: number; width?: number; text: string; anchorId?: string; color?: string; fillColor?: string; fontSize?: number; renderStyle?: "clean" | "sketch" }
  | { type: "create_icon"; id?: string; name?: string; d?: string; x: number; y: number; size?: number; color?: string; parentId?: string }
  | { type: "define_symbol"; name: string; d: string }
  | { type: "create_agent_marker"; id?: string; points?: InkPoint[]; x?: number; y?: number; text?: string; anchorId?: string }
  | { type: "translate"; ids: string[]; dx: number; dy: number }
  | { type: "resize"; id: string; x: number; y: number; width: number; height: number }
  | { type: "update_text"; id: string; text: string }
  | { type: "update_points"; id: string; points: InkPoint[] }
  | { type: "update_style"; ids: string[]; route?: ConnectorRoute; color?: string; strokeWidth?: number; fillColor?: string; fillOpacity?: number; fontSize?: number; radius?: number; opacity?: number; lineStyle?: "solid" | "dashed" | "dotted"; arrowHeads?: "end" | "start" | "both"; fontFamily?: "sans" | "serif" | "mono" | "handwriting"; fontWeight?: 400 | 500 | 600 | 700; fontStyle?: "normal" | "italic"; textDecoration?: "none" | "underline" | "line-through"; textAlign?: "left" | "center" | "right"; blockStyle?: TextElement["blockStyle"]; highlightColor?: string; renderStyle?: "clean" | "sketch" }
  | { type: "set_locked"; ids: string[]; locked: boolean }
  | { type: "reorder"; ids: string[]; direction: "front" | "back" }
  | { type: "connect"; id?: string; fromId: string; toId: string; label?: string; color?: string; strokeWidth?: number; route?: ConnectorRoute }
  | { type: "align"; ids: string[]; alignment: "left" | "center-x" | "right" | "top" | "center-y" | "bottom" }
  | { type: "auto_layout"; ids: string[]; direction: "row" | "column" | "grid"; gap?: number; align?: "start" | "center" | "end"; columns?: number }
  | { type: "fit_to_content"; id: string; mode?: "container" | "text"; padding?: number }
  | { type: "distribute"; ids: string[]; axis: "horizontal" | "vertical"; gap?: number }
  | { type: "duplicate"; ids: string[]; dx?: number; dy?: number }
  | { type: "group"; ids: string[]; groupId?: string }
  | { type: "ungroup"; groupId?: string; ids?: string[] }
  | { type: "set_parent"; ids: string[]; parentId?: string }
  | { type: "update_artboard"; id: string; name?: string; preset?: "desktop" | "tablet" | "mobile" | "custom"; backgroundColor?: string; clipContent?: boolean }
  | { type: "set_explanation_sequence"; sequence: ExplanationSequence }
  | { type: "present_step"; sequenceId?: string; index: number }
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
    case "create_text": return finite(operation.x) && finite(operation.y) && typeof operation.text === "string" && optionalFinite(operation.fontSize) && optionalFinite(operation.width) && optionalOneOf(operation.fontFamily, ["sans", "serif", "mono", "handwriting"]) && optionalNumberOf(operation.fontWeight, [400, 500, 600, 700]) && optionalOneOf(operation.fontStyle, ["normal", "italic"]) && optionalOneOf(operation.textDecoration, ["none", "underline", "line-through"]) && optionalOneOf(operation.textAlign, ["left", "center", "right"]) && optionalOneOf(operation.renderStyle, ["clean", "sketch"]);
    case "create_note": return finite(operation.x) && finite(operation.y) && typeof operation.text === "string" && optionalFinite(operation.width) && optionalFinite(operation.height) && optionalOneOf(operation.renderStyle, ["clean", "sketch"]);
    case "create_table": return finite(operation.x) && finite(operation.y) && finite(operation.width) && finite(operation.height) && finite(operation.rows) && finite(operation.columns) && operation.rows >= 1 && operation.rows <= 20 && operation.columns >= 1 && operation.columns <= 12;
    case "create_frame": return finite(operation.x) && finite(operation.y) && finite(operation.width) && finite(operation.height) && optionalOneOf(operation.renderStyle, ["clean", "sketch"]);
    case "create_highlight": return finite(operation.x) && finite(operation.y) && finite(operation.width) && (operation.points === undefined || (Array.isArray(operation.points) && operation.points.length > 1 && operation.points.every(position))) && optionalFinite(operation.size) && optionalFinite(operation.opacity);
    case "highlight_text": return ids(operation.ids) && optionalFinite(operation.opacity) && optionalFinite(operation.padding);
    case "create_shape": return ["rectangle", "ellipse", "diamond", "triangle"].includes(String(operation.kind)) && finite(operation.x) && finite(operation.y) && finite(operation.width) && finite(operation.height) && optionalFinite(operation.radius) && optionalFinite(operation.strokeWidth) && optionalFinite(operation.fillOpacity) && optionalOneOf(operation.lineStyle, ["solid", "dashed", "dotted"]) && optionalOneOf(operation.renderStyle, ["clean", "sketch"]);
    case "create_arrow": return position(operation.from) && position(operation.to) && optionalFinite(operation.strokeWidth) && optionalOneOf(operation.arrowHeads, ["end", "start", "both"]) && optionalOneOf(operation.lineStyle, ["solid", "dashed", "dotted"]);
    case "create_stroke": return Array.isArray(operation.points) && operation.points.length > 1 && operation.points.every(position);
    case "create_polygon": return Array.isArray(operation.points) && operation.points.length > 1 && operation.points.every(position);
    case "create_icon": return (typeof operation.d === "string" ? operation.d.trim().length > 0 : typeof operation.name === "string" && operation.name.trim().length > 0) && finite(operation.x) && finite(operation.y) && optionalFinite(operation.size);
    case "define_symbol": return typeof operation.name === "string" && /^[a-z0-9][a-z0-9 _-]{0,39}$/i.test(operation.name) && !(iconNames as string[]).includes(operation.name) && typeof operation.d === "string" && parseSvgPath(operation.d).length > 0;
    case "create_path": return (typeof operation.d === "string" && operation.d.trim().length > 0 ? finite(operation.x) && finite(operation.y) && optionalFinite(operation.width) && optionalFinite(operation.height) : Array.isArray(operation.points) && operation.points.length > 1 && operation.points.every(position)) && optionalFinite(operation.bow) && optionalFinite(operation.strokeWidth);
    case "create_annotation": return (annotationKinds as string[]).includes(String(operation.kind)) && finite(operation.x) && finite(operation.y) && finite(operation.width) && finite(operation.height) && optionalOneOf(operation.direction, ["left", "right", "up", "down"]) && optionalFinite(operation.strokeWidth) && optionalFinite(operation.fontSize) && (operation.text === undefined || typeof operation.text === "string");
    case "create_callout": return finite(operation.x) && finite(operation.y) && typeof operation.text === "string" && operation.text.trim().length > 0 && optionalFinite(operation.width) && optionalFinite(operation.fontSize) && (operation.anchorId === undefined || typeof operation.anchorId === "string");
    case "auto_layout": return ids(operation.ids) && operation.ids.length > 1 && ["row", "column", "grid"].includes(String(operation.direction)) && optionalFinite(operation.gap) && optionalOneOf(operation.align, ["start", "center", "end"]) && optionalFinite(operation.columns);
    case "fit_to_content": return typeof operation.id === "string" && optionalOneOf(operation.mode, ["container", "text"]) && optionalFinite(operation.padding);
    case "create_agent_marker": return (Array.isArray(operation.points) && operation.points.length > 1 && operation.points.every(position)) || (finite(operation.x) && finite(operation.y) && typeof operation.text === "string" && operation.text.trim().length > 0);
    case "translate": return ids(operation.ids) && finite(operation.dx) && finite(operation.dy);
    case "resize": return typeof operation.id === "string" && finite(operation.x) && finite(operation.y) && finite(operation.width) && finite(operation.height);
    case "update_text": return typeof operation.id === "string" && typeof operation.text === "string";
    case "update_points": return typeof operation.id === "string" && Array.isArray(operation.points) && operation.points.length > 1 && operation.points.every(position);
    case "update_style": return ids(operation.ids) && optionalOneOf(operation.route, ["straight", "orthogonal", "curved"]) && optionalFinite(operation.strokeWidth) && optionalFinite(operation.fillOpacity) && optionalFinite(operation.fontSize) && optionalFinite(operation.radius) && optionalFinite(operation.opacity) && optionalOneOf(operation.lineStyle, ["solid", "dashed", "dotted"]) && optionalOneOf(operation.arrowHeads, ["end", "start", "both"]) && optionalOneOf(operation.fontFamily, ["sans", "serif", "mono", "handwriting"]) && optionalNumberOf(operation.fontWeight, [400, 500, 600, 700]) && optionalOneOf(operation.fontStyle, ["normal", "italic"]) && optionalOneOf(operation.textDecoration, ["none", "underline", "line-through"]) && optionalOneOf(operation.textAlign, ["left", "center", "right"]);
    case "set_locked": return ids(operation.ids) && typeof operation.locked === "boolean";
    case "reorder": return ids(operation.ids) && (operation.direction === "front" || operation.direction === "back");
    case "connect": return typeof operation.fromId === "string" && typeof operation.toId === "string" && optionalOneOf(operation.route, ["straight", "orthogonal", "curved"]);
    case "align": return ids(operation.ids) && ["left", "center-x", "right", "top", "center-y", "bottom"].includes(String(operation.alignment));
    case "distribute": return ids(operation.ids) && (operation.axis === "horizontal" || operation.axis === "vertical") && (operation.gap === undefined || finite(operation.gap));
    case "duplicate": return ids(operation.ids) && (operation.dx === undefined || finite(operation.dx)) && (operation.dy === undefined || finite(operation.dy));
    case "group": return ids(operation.ids) && operation.ids.length > 0 && (operation.groupId === undefined || typeof operation.groupId === "string");
    case "ungroup": return typeof operation.groupId === "string" || ids(operation.ids);
    case "set_parent": return ids(operation.ids) && (operation.parentId === undefined || typeof operation.parentId === "string");
    case "update_artboard": return typeof operation.id === "string" && optionalOneOf(operation.preset, ["desktop", "tablet", "mobile", "custom"]);
    case "set_explanation_sequence": {
      const sequence = operation.sequence as Record<string, unknown> | undefined;
      return Boolean(sequence) && typeof sequence?.id === "string" && typeof sequence.title === "string" && Array.isArray(sequence.steps)
        && sequence.steps.length > 0 && sequence.steps.length <= 60 && sequence.steps.every((step) => Boolean(step) && typeof step.id === "string" && typeof step.title === "string" && ids(step.focusElementIds) && ids(step.revealElementIds));
    }
    case "present_step": return finite(operation.index) && operation.index >= 0 && (operation.sequenceId === undefined || typeof operation.sequenceId === "string");
    case "delete": return ids(operation.ids);
    default: return false;
  }
}

export const defaultSettings = (): WhiteboardSettings => ({ inputSmoothing: true, pressure: true, autoShape: false, smartHighlight: true, englishHandwritingAssist: true, autoAcceptAgent: false, cleanStyle: false });
export const emptyBoard = (): WhiteboardDocument => ({ version: 3, revision: 0, elements: [], agentElementIds: [], request: null, turn: null, settings: defaultSettings(), lastAgentRevision: 0, connections: {}, groups: {}, artboardIds: [], explanationSequences: [], sources: [], presentation: null, symbols: {}, journal: [] });

export function cloneBoard(document: WhiteboardDocument): WhiteboardDocument { return structuredClone(document); }

export function validBoard(value: unknown): value is WhiteboardDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WhiteboardDocument>;
  return candidate.version === 3 && typeof candidate.revision === "number" && Array.isArray(candidate.elements) && Array.isArray(candidate.agentElementIds) && Boolean(candidate.settings);
}

export function migrateBoard(value: unknown): WhiteboardDocument | null {
  if (validBoard(value)) {
    const board = cloneBoard(value); board.artboardIds ??= []; board.explanationSequences ??= []; board.sources ??= []; board.presentation ??= null;
    if (board.turn) { board.turn.promptText ??= ""; board.turn.agentMarkers ??= []; board.turn.pendingChangeIds ??= []; }
    return board;
  }
  if (!value || typeof value !== "object") return null; const legacy = value as {
    version?: number;
    revision?: number;
    elements?: PageElement[];
    agentElementIds?: string[];
    request?: CollaborationRequest | null;
    connections?: WhiteboardDocument["connections"];
    groups?: WhiteboardDocument["groups"];
  };
  if (![1, 2].includes(legacy.version ?? 0) || typeof legacy.revision !== "number" || !Array.isArray(legacy.elements) || !Array.isArray(legacy.agentElementIds)) return null;
  const request = legacy.request ?? null;
  const legacyTurn = (legacy as { turn?: CollaborationTurn | null }).turn;
  const turn: CollaborationTurn | null = legacyTurn ? {
    ...structuredClone(legacyTurn), promptText: legacyTurn.promptText ?? "", agentMarkers: legacyTurn.agentMarkers ?? [], pendingChangeIds: legacyTurn.pendingChangeIds ?? []
  } : request && request.state !== "answered" ? { id: request.id, status: request.state === "working" ? "working" : "queued", submittedRevision: legacy.revision, createdAt: request.createdAt, promptText: request.instruction ?? "", selectionIds: request.selectionIds, instructionInk: request.ink ?? [], agentMarkers: [], priorityRegions: [], changedElementIds: [], pendingChangeIds: [] } : null;
  const elements = structuredClone(legacy.elements);
  const artboardIds = elements.filter((element) => element.artboard || element.semanticRole === "artboard").map((element) => element.id);
  return { version: 3, revision: legacy.revision, elements, agentElementIds: [...legacy.agentElementIds], request: null, turn, settings: { ...defaultSettings(), ...(legacy as { settings?: Partial<WhiteboardSettings> }).settings }, lastAgentRevision: (legacy as { lastAgentRevision?: number }).lastAgentRevision ?? 0, connections: structuredClone(legacy.connections ?? {}), groups: structuredClone(legacy.groups ?? {}), artboardIds, explanationSequences: [], sources: [], presentation: (legacy as { presentation?: WhiteboardDocument["presentation"] }).presentation ?? null, symbols: { ...(legacy as { symbols?: Record<string, string> }).symbols }, journal: [...((legacy as { journal?: JournalEntry[] }).journal ?? [])].slice(-MAX_JOURNAL_ENTRIES) };
}

export function boardBounds(elements: PageElement[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (elements.length === 0) return null; return boundsForElements(elements);
}

export function translateElement(element: PageElement, dx: number, dy: number): void {
  if (element.type === "stroke" || element.type === "shape") element.points.forEach((point) => { point.x += dx; point.y += dy; });
  else if (element.type === "text") { element.x += dx; element.baseline += dy; }
  else if (element.type === "image") { element.x += dx; element.y += dy; }
  else { element.x1 += dx; element.x2 += dx; element.y += dy; element.points?.forEach((point) => { point.x += dx; point.y += dy; }); }
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
    element.y = to.minY + (element.y - from.minY) * sy; element.points?.forEach(point); element.size *= Math.sqrt(Math.abs(sx * sy));
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
    return { type: "text", id: operation.id ?? id("text"), x: operation.x, baseline: operation.y + fontSize, width, height: estimateTextHeight(operation.text, width, fontSize, { fontFamily: operation.fontFamily, fontWeight: operation.fontWeight, fontStyle: operation.fontStyle, blockStyle: operation.blockStyle }), fontSize, color: operation.color ?? "#000000", text: operation.text, fontFamily: operation.fontFamily, fontWeight: operation.fontWeight, fontStyle: operation.fontStyle, textDecoration: operation.textDecoration, textAlign: operation.textAlign, blockStyle: operation.blockStyle, highlightColor: operation.highlightColor, renderStyle: operation.renderStyle, semanticRole: operation.semanticRole, parentId: operation.parentId, name: operation.name, sourceRefs: operation.sourceRefs } satisfies TextElement;
  }
  if (operation.type === "create_highlight") return { type: "highlight", id: operation.id ?? id("highlight"), x1: operation.x, x2: operation.x + operation.width, y: operation.y, points: operation.points?.map((point) => ({ ...point, pressure: point.pressure ?? .5 })), size: operation.size ?? 28, color: operation.color ?? "#ffd84d", opacity: operation.opacity ?? 0.28 };
  if (operation.type === "create_arrow") return { type: "shape", id: operation.id ?? id("arrow"), kind: "arrow", points: [{ ...operation.from, pressure: 0.5 }, { ...operation.to, pressure: 0.5 }], color: operation.color ?? "#000000", size: operation.strokeWidth ?? 3, closed: false, startArrow: operation.arrowHeads === "start" || operation.arrowHeads === "both", endArrow: operation.arrowHeads !== "start", lineStyle: operation.lineStyle } satisfies ShapeElement;
  if (operation.type === "create_stroke") return { type: "stroke", id: operation.id ?? id("stroke"), color: operation.color ?? "#000000", size: operation.size ?? 3, pressureSensitivity: 0.65, points: operation.points.map((point) => ({ ...point, pressure: point.pressure ?? 0.5 })) };
  if (operation.type === "create_polygon") return { type: "shape", id: operation.id ?? id("polygon"), kind: operation.closed === false ? "line" : "polygon", points: operation.points.map((point) => ({ ...point, pressure: point.pressure ?? 0.5 })), color: operation.color ?? "#000000", size: operation.strokeWidth ?? 3, closed: operation.closed !== false, fillColor: operation.fillColor ?? "#ffffff", fillOpacity: operation.fillOpacity ?? 0 } satisfies ShapeElement;
  return { type: "shape", id: operation.id ?? id("shape"), kind: operation.kind === "ellipse" ? "ellipse" : "rectangle", points: [{ x: operation.x, y: operation.y, pressure: 0.5 }, { x: operation.x + operation.width, y: operation.y + operation.height, pressure: 0.5 }], color: operation.color ?? "#000000", size: operation.strokeWidth ?? 3, closed: true, fillColor: operation.fillColor ?? "#c0c0c0", fillOpacity: operation.fillOpacity ?? (operation.filled ? 0.3 : 0), radius: operation.kind === "rectangle" ? Math.max(0, operation.radius ?? 0) : undefined, lineStyle: operation.lineStyle, semanticRole: operation.semanticRole, parentId: operation.parentId, name: operation.name } satisfies ShapeElement;
}

/**
 * Height a text element really needs. Measured against the renderer's own font and wrapping when a
 * DOM is available, so container sizing and the text-overflow lint agree with what is painted.
 */
export function estimateTextHeight(text: string, width: number, fontSize: number, style: Omit<TextMetricsInput, "fontSize"> = {}): number {
  return measuredTextHeight({ text, width, fontSize, ...style });
}

/**
 * Compact by default: sampled geometry is replaced by a point count so that a handwritten board
 * stays inside a sane tool-output budget. Pass "geometry" for targeted point-level inspection.
 */
export function elementSummary(element: PageElement, detail: "summary" | "geometry" = "summary"): Record<string, unknown> {
  const bounds = elementBounds(element); const base = { id: element.id, type: element.type, bounds, name: element.name ?? null, parentId: element.parentId ?? null, artboard: element.artboard ?? null, sourceRefs: element.sourceRefs ?? [], locked: element.locked ?? false, semanticRole: element.semanticRole ?? null, renderStyle: element.renderStyle ?? "clean", opacity: element.opacity ?? 1, agentAttached: element.agentAttached ?? false };
  const geometry = (points: InkPoint[] | undefined): Record<string, unknown> => {
    if (!points) return { points: null, pointCount: 0 };
    // Endpoint-defined shapes (rectangle, ellipse, arrow, line) stay readable at any detail level.
    if (detail === "geometry" || points.length <= 4) return { points, pointCount: points.length };
    return { points: null, pointCount: points.length };
  };
  if (element.type === "text") return { ...base, text: element.text, fontSize: element.fontSize, color: element.color, width: element.width, height: element.height, fontFamily: element.fontFamily ?? "sans", fontWeight: element.fontWeight ?? 400, fontStyle: element.fontStyle ?? "normal", textDecoration: element.textDecoration ?? "none", textAlign: element.textAlign ?? "left", blockStyle: element.blockStyle ?? "body", highlightColor: element.highlightColor ?? null };
  if (element.type === "shape") return { ...base, kind: element.kind, ...geometry(element.points), color: element.color, strokeWidth: element.size, fillColor: element.fillColor, fillOpacity: element.fillOpacity ?? 0, radius: element.radius ?? 0, lineStyle: element.lineStyle ?? "solid", arrowHeads: element.startArrow ? (element.endArrow === false ? "start" : "both") : "end" };
  if (element.type === "highlight") return { ...base, x1: element.x1, x2: element.x2, y: element.y, ...geometry(element.points), size: element.size, color: element.color, opacity: element.opacity };
  if (element.type === "stroke") return { ...base, ...geometry(element.points), color: element.color, strokeWidth: element.size, recognitionText: element.recognitionText ?? null };
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
    const elementPoints = element.type === "stroke" || element.type === "shape" || (element.type === "highlight" && element.points?.length) ? element.points! : corners;
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

function interpolatePoint(a: InkPoint, b: InkPoint, t: number): InkPoint {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    pressure: (a.pressure ?? .5) + ((b.pressure ?? .5) - (a.pressure ?? .5)) * t,
    time: a.time !== undefined && b.time !== undefined ? a.time + (b.time - a.time) * t : undefined
  };
}

/** Split a sampled ink path wherever a circular eraser intersects it. */
export function erasePolyline(points: InkPoint[], centre: InkPoint, radius: number): InkPoint[][] {
  if (points.length < 2 || radius <= 0) return points.length > 1 ? [points.map((point) => ({ ...point }))] : [];
  const output: InkPoint[][] = []; let current: InkPoint[] = [];
  const push = (point: InkPoint): void => { const previous = current.at(-1); if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > .001) current.push(point); };
  const flush = (): void => { if (current.length > 1) output.push(current); current = []; };
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]; const b = points[index]; const dx = b.x - a.x; const dy = b.y - a.y;
    const fx = a.x - centre.x; const fy = a.y - centre.y; const aa = dx * dx + dy * dy;
    const cuts = [0, 1];
    if (aa > .000001) {
      const bb = 2 * (fx * dx + fy * dy); const cc = fx * fx + fy * fy - radius * radius; const discriminant = bb * bb - 4 * aa * cc;
      if (discriminant >= 0) {
        const root = Math.sqrt(discriminant); const left = (-bb - root) / (2 * aa); const right = (-bb + root) / (2 * aa);
        if (left > 0 && left < 1) cuts.push(left); if (right > 0 && right < 1) cuts.push(right);
      }
    }
    cuts.sort((left, right) => left - right);
    for (let cut = 1; cut < cuts.length; cut += 1) {
      const from = cuts[cut - 1]; const to = cuts[cut]; const midpoint = interpolatePoint(a, b, (from + to) / 2);
      const outside = Math.hypot(midpoint.x - centre.x, midpoint.y - centre.y) > radius;
      if (outside) { push(interpolatePoint(a, b, from)); push(interpolatePoint(a, b, to)); } else flush();
    }
  }
  flush(); return output;
}

/** Returns null when untouched, otherwise the replacement segments (possibly empty). */
export function eraseInkElement(element: PageElement, centre: InkPoint, radius: number): PageElement[] | null {
  if (element.type !== "stroke" && (element.type !== "highlight" || !element.points?.length)) return null;
  const points = element.type === "stroke" ? element.points : element.points!; const effectiveRadius = radius + element.size / 2;
  const segments = erasePolyline(points, centre, effectiveRadius);
  const originalLength = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
  const remainingLength = segments.reduce((total, segment) => total + segment.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - segment[index].x, point.y - segment[index].y), 0), 0);
  if (Math.abs(originalLength - remainingLength) < .001) return null;
  return segments.map((segment, index) => {
    const copy = structuredClone(element); copy.id = index === 0 ? element.id : `${element.id}-part-${crypto.randomUUID()}`; copy.points = segment;
    if (copy.type === "highlight") { copy.x1 = segment[0].x; copy.x2 = segment.at(-1)!.x; copy.y = segment.reduce((sum, point) => sum + point.y, 0) / segment.length; }
    return copy;
  });
}

function relativeLuminance(hex: string): number | null {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null; const values = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}

const CONTROL_ROLES = ["button", "input", "checkbox", "radio", "switch", "select", "tab", "tabs"];
const CONTAINER_ROLES = ["artboard", "frame", "screen", "section", "modal", "list", "sidebar", "header", "navbar", "table-cell", "note"];

/**
 * Design review the agent can act on. Every issue names the elements it is about, so the agent can
 * fix exactly those ids. Kept cheap: it runs on every inspect and after every agent batch.
 */
export function lintBoard(document: WhiteboardDocument): BoardLintIssue[] {
  const issues: BoardLintIssue[] = []; const elements = document.elements; const byId = new Map(elements.map((element) => [element.id, element]));
  const groupOf = new Map<string, string>();
  for (const [groupId, members] of Object.entries(document.groups ?? {})) for (const member of members) groupOf.set(member, groupId);
  const childTextOf = new Map<string, boolean>();
  for (const element of elements) if (element.type === "text" && element.text.trim()) {
    if (element.parentId) childTextOf.set(element.parentId, true);
    const group = groupOf.get(element.id); if (group) for (const sibling of document.groups?.[group] ?? []) childTextOf.set(sibling, true);
  }
  /** The card a label was created with: the shape in its own group. A label must fit inside it. */
  const cardOf = (text: PageElement): PageElement | null => {
    const group = groupOf.get(text.id); if (!group) return null;
    const shapes = (document.groups?.[group] ?? []).map((id) => byId.get(id))
      .filter((member): member is Extract<PageElement, { type: "shape" }> => member?.type === "shape" && (member.kind === "rectangle" || member.kind === "ellipse"));
    if (!shapes.length) return null;
    const box = elementBounds(text);
    // The card is the one the label starts inside; failing that, the biggest shape of the group.
    return shapes.find((shape) => { const card = elementBounds(shape); return box.minX >= card.minX - 2 && box.minY >= card.minY - 2; })
      ?? shapes.reduce((widest, shape) => (elementBounds(shape).maxX - elementBounds(shape).minX) > (elementBounds(widest).maxX - elementBounds(widest).minX) ? shape : widest);
  };

  // Smallest filled shape first: a label is judged against the button it sits on, not the page behind it.
  const filledSurfaces = elements
    .filter((element): element is Extract<PageElement, { type: "shape" }> => element.type === "shape" && Boolean(element.fillColor) && (element.fillOpacity ?? 0) > .7)
    .slice(-120)
    .map((element) => ({ id: element.id, fill: element.fillColor!, bounds: elementBounds(element) }))
    .sort((left, right) => (left.bounds.maxX - left.bounds.minX) * (left.bounds.maxY - left.bounds.minY) - (right.bounds.maxX - right.bounds.minX) * (right.bounds.maxY - right.bounds.minY));
  for (const element of elements) {
    const bounds = elementBounds(element); const width = bounds.maxX - bounds.minX; const height = bounds.maxY - bounds.minY;
    if (element.type === "text" && element.height !== undefined && estimateTextHeight(element.text, element.width, element.fontSize, element) > element.height + 2) issues.push({ code: "text-overflow", severity: "warning", elementIds: [element.id], message: "Text does not fit its text box.", suggestedFix: "Increase the box height or reduce the font size." });
    if (element.type === "text" && !element.parentId) {
      // A card with a fixed height clips its own label, and that is invisible until someone reads it.
      const card = cardOf(element);
      if (card) {
        const box = elementBounds(card);
        if (bounds.maxY > box.maxY + 2 || bounds.maxX > box.maxX + 2 || bounds.minY < box.minY - 2 || bounds.minX < box.minX - 2) {
          issues.push({ code: "spills-card", severity: "warning", elementIds: [element.id, card.id], message: "Text sticks out of the card it belongs to.", suggestedFix: "Grow the card with fit_to_content, or shorten the text." });
        }
      }
    }
    if (element.type === "text" && ["note-body", "callout-text"].includes(element.semanticRole ?? "") && element.text.length > 240) issues.push({ code: "wordy-card", severity: "info", elementIds: [element.id], message: "This card carries a paragraph.", suggestedFix: "Keep a headline on the card and move the explanation into a guided step, where the board shows it under the controls." });
    if (CONTROL_ROLES.includes(element.semanticRole ?? "") && (width < 44 || height < 44)) issues.push({ code: "small-target", severity: "warning", elementIds: [element.id], message: "Interactive target is smaller than 44 x 44.", suggestedFix: "Enlarge the control or give it a larger invisible hit area." });
    if (CONTROL_ROLES.includes(element.semanticRole ?? "") && element.type !== "text" && !element.name && !childTextOf.get(element.id)) issues.push({ code: "unlabelled-control", severity: "warning", elementIds: [element.id], message: "Control has no visible label and no name.", suggestedFix: "Add a text label inside the control, group it with one, or set a name." });
    if (element.parentId) {
      const parent = byId.get(element.parentId); if (parent) { const frame = elementBounds(parent); if (bounds.minX < frame.minX || bounds.minY < frame.minY || bounds.maxX > frame.maxX || bounds.maxY > frame.maxY) issues.push({ code: "off-artboard", severity: "warning", elementIds: [element.id, parent.id], message: "Element sticks out of its artboard.", suggestedFix: "Move the element inside the artboard or enable clipping on purpose." }); }
    }
    if (element.type === "text") {
      const surface = surfaceUnder(bounds, filledSurfaces);
      if (surface) {
        const foreground = relativeLuminance(element.color); const background = relativeLuminance(surface.fill);
        if (foreground !== null && background !== null) {
          const ratio = (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
          if (ratio < 4.5) issues.push({ code: "low-contrast", severity: "warning", elementIds: [element.id, surface.id], message: `Text contrast is only ${ratio.toFixed(1)}:1.`, suggestedFix: "Pick a text or background colour with more contrast." });
        }
      }
    }
  }
  // A connector label belongs to its line, which is already exempt: placement does its best to keep
  // it clear, and on a dense diagram there is no free spot for the agent to move it to anyway.
  const connectorLabels = new Set(Object.values(document.connections ?? {}).map((connection) => connection.labelId).filter((id): id is string => Boolean(id)));
  issues.push(...overlapIssues(elements.filter((element) => !connectorLabels.has(element.id)), groupOf));
  return issues.slice(0, 80);
}

function surfaceUnder(bounds: Bounds, surfaces: Array<{ id: string; fill: string; bounds: Bounds }>): { id: string; fill: string } | null {
  return surfaces.find((surface) => bounds.minX >= surface.bounds.minX && bounds.maxX <= surface.bounds.maxX && bounds.minY >= surface.bounds.minY && bounds.maxY <= surface.bounds.maxY) ?? null;
}

/** Unrelated objects that sit on top of each other: the defect fixed layout code cannot see. */
function overlapIssues(elements: PageElement[], groupOf: Map<string, string>): BoardLintIssue[] {
  const candidates = elements
    .filter((element) => element.type !== "highlight" && !(element.type === "shape" && (element.kind === "arrow" || element.kind === "line")) && !element.artboard && !CONTAINER_ROLES.includes(element.semanticRole ?? ""))
    .slice(-120)
    .map((element) => ({ element, bounds: elementBounds(element) }));
  const issues: BoardLintIssue[] = [];
  for (let left = 0; left < candidates.length && issues.length < 12; left += 1) {
    for (let right = left + 1; right < candidates.length && issues.length < 12; right += 1) {
      const a = candidates[left]; const b = candidates[right];
      if (a.element.parentId === b.element.id || b.element.parentId === a.element.id) continue;
      const group = groupOf.get(a.element.id); if (group && group === groupOf.get(b.element.id)) continue;
      const overlap = boundsOverlapArea(a.bounds, b.bounds); if (overlap <= 0) continue;
      const areaA = Math.max(1, (a.bounds.maxX - a.bounds.minX) * (a.bounds.maxY - a.bounds.minY));
      const areaB = Math.max(1, (b.bounds.maxX - b.bounds.minX) * (b.bounds.maxY - b.bounds.minY));
      const coverage = overlap / Math.min(areaA, areaB);
      // A label sitting inside its card is a layout pattern, not a defect.
      const smaller = areaA <= areaB ? a.element : b.element;
      if (smaller.type === "text" && coverage >= .85) continue;
      // Something clipping the edge of a word is already unreadable, so text is judged more strictly
      // than two boxes that merely touch.
      const wordInvolved = (a.element.type === "text") !== (b.element.type === "text");
      if (coverage < (wordInvolved ? .12 : .35)) continue;
      issues.push({ code: "overlap", severity: "warning", elementIds: [a.element.id, b.element.id], message: "Two unrelated objects overlap.", suggestedFix: "Move one object, or group them if the overlap is intended." });
    }
  }
  return issues;
}

function segmentsIntersect(a: InkPoint, b: InkPoint, c: InkPoint, d: InkPoint): boolean {
  const cross = (left: InkPoint, middle: InkPoint, right: InkPoint): number => (middle.x - left.x) * (right.y - left.y) - (middle.y - left.y) * (right.x - left.x);
  const abC = cross(a, b, c); const abD = cross(a, b, d); const cdA = cross(c, d, a); const cdB = cross(c, d, b);
  const overlaps = Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x))
    && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
  return overlaps && ((abC <= 0 && abD >= 0) || (abC >= 0 && abD <= 0)) && ((cdA <= 0 && cdB >= 0) || (cdA >= 0 && cdB <= 0));
}

/**
 * Full connector path between two objects. Straight keeps the old behaviour; orthogonal and curved
 * leave the direct line so diagrams stop drawing through their own nodes. The result is an ordinary
 * point list, so renderer, exporter and hit testing need no special case.
 */
/** True when any segment of the path cuts through one of the boxes. */
export function routeBlocked(points: InkPoint[], obstacles: Bounds[]): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]; const b = points[index];
    for (const box of obstacles) {
      const corners = [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }];
      if (a.x > box.minX && a.x < box.maxX && a.y > box.minY && a.y < box.maxY) return true;
      for (let corner = 0; corner < 4; corner += 1) {
        const c = corners[corner]; const d = corners[(corner + 1) % 4];
        if (segmentsIntersect(a, b, { ...c, pressure: .5 }, { ...d, pressure: .5 })) return true;
      }
    }
  }
  return false;
}

/** Where a connector attaches and which corridor it runs in, so parallel edges stay apart. */
export interface ConnectorLanes { from?: number; to?: number; corridor?: number }

export function connectionRoute(from: PageElement, to: PageElement, route: ConnectorRoute = "straight", obstacles: Bounds[] = [], lanes: number | ConnectorLanes = 0): InkPoint[] {
  const lane = typeof lanes === "number" ? { corridor: lanes, from: 0, to: 0 } : { corridor: lanes.corridor ?? 0, from: lanes.from ?? 0, to: lanes.to ?? 0 };
  const anchors = connectionPoints(from, to);
  if (route === "straight") return [anchors.from, anchors.to];

  const a = elementBounds(from); const b = elementBounds(to);
  const horizontal = Math.abs((b.minX + b.maxX) / 2 - (a.minX + a.maxX) / 2) >= Math.abs((b.minY + b.maxY) / 2 - (a.minY + a.maxY) / 2);
  const start = sideAnchor(a, horizontal, horizontal ? (b.minX + b.maxX) / 2 > (a.minX + a.maxX) / 2 : (b.minY + b.maxY) / 2 > (a.minY + a.maxY) / 2, lane.from * LANE_GAP);
  const end = sideAnchor(b, horizontal, horizontal ? (a.minX + a.maxX) / 2 > (b.minX + b.maxX) / 2 : (a.minY + a.maxY) / 2 > (b.minY + b.maxY) / 2, lane.to * LANE_GAP);
  if (route === "orthogonal") {
    // Two ways to turn a corner: meet on a shared x, or meet on a shared y.
    const build = (alongX: boolean, middle: number): InkPoint[] => alongX
      ? [start, { x: middle, y: start.y, pressure: .5 }, { x: middle, y: end.y, pressure: .5 }, end]
      : [start, { x: start.x, y: middle, pressure: .5 }, { x: end.x, y: middle, pressure: .5 }, end];
    const centre = (horizontal ? (start.x + end.x) / 2 : (start.y + end.y) / 2) + lane.corridor * LANE_GAP;
    const direct = build(horizontal, centre);
    if (!obstacles.length || !routeBlocked(direct, obstacles)) return direct;
    const margin = 28;
    const nearest = (values: number[], from: number): number[] => [...values].sort((left, right) => Math.abs(left - from) - Math.abs(right - from));
    // Slide the corner along the natural axis first; if the obstacle sits square in the way, leave
    // that axis altogether and go around it.
    const sameAxis = nearest(obstacles.flatMap((box) => horizontal ? [box.minX - margin, box.maxX + margin] : [box.minY - margin, box.maxY + margin]), horizontal ? start.x : start.y).map((middle) => build(horizontal, middle));
    const crossAxis = nearest(obstacles.flatMap((box) => horizontal ? [box.minY - margin, box.maxY + margin] : [box.minX - margin, box.maxX + margin]), horizontal ? start.y : start.x).map((middle) => build(!horizontal, middle));
    return [...sameAxis, ...crossAxis].find((candidate) => !routeBlocked(candidate, obstacles)) ?? direct;
  }
  const dx = end.x - start.x; const dy = end.y - start.y; const length = Math.max(1, Math.hypot(dx, dy));
  const sample = (bow: number): InkPoint[] => {
    const control = { x: (start.x + end.x) / 2 - dy / length * bow, y: (start.y + end.y) / 2 + dx / length * bow };
    return Array.from({ length: 15 }, (_, index) => {
      const t = index / 14; const inverse = 1 - t;
      return { x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x, y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y, pressure: .5 };
    });
  };
  const bow = Math.min(90, length * .18) * (1 + Math.abs(lane.corridor) * .45) * (lane.corridor < 0 ? -1 : 1);
  const curved = sample(bow);
  if (!routeBlocked(curved, obstacles)) return curved;
  // Try the other side, then a wider arc, before giving up on avoiding the obstacle.
  for (const candidate of [-bow, bow * 2, -bow * 2]) { const attempt = sample(candidate); if (!routeBlocked(attempt, obstacles)) return attempt; }
  return curved;
}

/** The chip drawn behind a connector label. Placement has to reserve it, or the chip clips a card. */
export const CONNECTOR_LABEL_PADDING = { x: 8, y: 5 };

/** Distance between two connectors that would otherwise share the same corridor. */
export const LANE_GAP = 24;

/** Attachment point on one side of a box, slid along that side by the lane offset. */
function sideAnchor(box: Bounds, horizontal: boolean, positive: boolean, offset = 0): InkPoint {
  const slide = (value: number, min: number, max: number): number => Math.max(min + 8, Math.min(max - 8, value + offset));
  if (horizontal) return { x: positive ? box.maxX : box.minX, y: slide((box.minY + box.maxY) / 2, box.minY, box.maxY), pressure: .5 };
  return { x: slide((box.minX + box.maxX) / 2, box.minX, box.maxX), y: positive ? box.maxY : box.minY, pressure: .5 };
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

/* ------------------------------------------------------------------ *
 * Spatial helpers shared by the AI-Pen gesture resolver and the tests. *
 * ------------------------------------------------------------------ */

export function expandBounds(bounds: Bounds, padding: number): Bounds {
  return { minX: bounds.minX - padding, minY: bounds.minY - padding, maxX: bounds.maxX + padding, maxY: bounds.maxY + padding };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function boundsOverlapArea(a: Bounds, b: Bounds): number {
  return Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
}

export function boundsForPoints(points: InkPoint[]): Bounds {
  return { minX: Math.min(...points.map((point) => point.x)), minY: Math.min(...points.map((point) => point.y)), maxX: Math.max(...points.map((point) => point.x)), maxY: Math.max(...points.map((point) => point.y)) };
}

/**
 * Turn a pointing gesture (AI pen bounds, lasso bounds) into the elements a person would read
 * as "these ones": everything the padded gesture actually covers, ranked by how much of each
 * element it covers, with a nearest-neighbour fallback for a bare arrow or dot.
 */
export function resolveGestureElements(elements: PageElement[], gesture: Bounds, limit = 12): string[] {
  const span = Math.max(gesture.maxX - gesture.minX, gesture.maxY - gesture.minY);
  const padding = Math.max(28, Math.min(140, span * 0.3));
  const padded = expandBounds(gesture, padding);
  const candidates = elements.map((element) => ({ element, bounds: elementBounds(element) }));
  const covered = candidates
    .map(({ element, bounds }) => {
      const area = Math.max(1, (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY));
      return { id: element.id, score: boundsOverlapArea(padded, bounds) / area, touches: boundsIntersect(padded, bounds) };
    })
    .filter((candidate) => candidate.touches && candidate.score > 0.02)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((candidate) => candidate.id);
  if (covered.length) return covered;
  const centre = { x: (gesture.minX + gesture.maxX) / 2, y: (gesture.minY + gesture.maxY) / 2 };
  const reach = Math.max(180, span * 1.5);
  return candidates
    .map(({ element, bounds }) => ({ id: element.id, distance: Math.hypot(Math.max(bounds.minX - centre.x, 0, centre.x - bounds.maxX), Math.max(bounds.minY - centre.y, 0, centre.y - bounds.maxY)) }))
    .filter((candidate) => candidate.distance <= reach)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 3)
    .map((candidate) => candidate.id);
}

/**
 * Cheap value fingerprint of one element. Any visible edit (position, size, text, style,
 * geometry, nesting) changes it, so human mutations can be detected centrally instead of
 * relying on every UI handler to remember to report itself.
 */
export function elementSignature(element: PageElement): string {
  const bounds = elementBounds(element);
  const round = (value: number): number => Math.round(value * 10) / 10;
  const box = `${round(bounds.minX)},${round(bounds.minY)},${round(bounds.maxX)},${round(bounds.maxY)}`;
  const shared = `${element.parentId ?? ""}|${element.locked ? 1 : 0}|${element.opacity ?? 1}|${element.semanticRole ?? ""}|${element.name ?? ""}|${element.agentAttached ? 1 : 0}`;
  if (element.type === "text") return `text|${box}|${element.text}|${element.fontSize}|${element.color}|${element.width}|${element.fontFamily ?? ""}|${element.fontWeight ?? ""}|${element.fontStyle ?? ""}|${element.textDecoration ?? ""}|${element.textAlign ?? ""}|${element.blockStyle ?? ""}|${element.highlightColor ?? ""}|${shared}`;
  if (element.type === "shape") return `shape|${box}|${element.kind}|${element.points.length}|${element.color}|${element.size}|${element.fillColor ?? ""}|${element.fillOpacity ?? 0}|${element.radius ?? 0}|${element.lineStyle ?? ""}|${element.startArrow ? 1 : 0}|${element.endArrow === false ? 0 : 1}|${shared}`;
  if (element.type === "stroke") return `stroke|${box}|${element.points.length}|${element.color}|${element.size}|${element.recognitionText ?? ""}|${shared}`;
  if (element.type === "highlight") return `highlight|${box}|${element.points?.length ?? 0}|${element.color}|${element.size}|${element.opacity}|${shared}`;
  return `image|${box}|${element.width}|${element.height}|${element.sourceName ?? ""}|${shared}`;
}

/* ---------------------------------------------------- *
 * Operation preflight: no batch may partially mutate.   *
 * ---------------------------------------------------- */

/**
 * The drawn symbols, in a 0..1 box. Written as path data because that is how these shapes are
 * actually described — one line here beats thirty hand-placed points, and adding one is cheap.
 */
const iconPaths: Partial<Record<IconName, string>> = {
  server: "M .08 .16 H .92 V .42 H .08 Z M .08 .58 H .92 V .84 H .08 Z M .18 .29 h .1 M .18 .71 h .1 M .74 .29 h .08 M .74 .71 h .08",
  database: "M .5 .1 C .78 .1 .88 .16 .88 .22 C .88 .28 .78 .34 .5 .34 C .22 .34 .12 .28 .12 .22 C .12 .16 .22 .1 .5 .1 Z M .12 .22 V .5 C .12 .56 .22 .62 .5 .62 C .78 .62 .88 .56 .88 .5 V .22 M .12 .5 V .78 C .12 .84 .22 .9 .5 .9 C .78 .9 .88 .84 .88 .78 V .5",
  cloud: "M .28 .74 C .12 .74 .06 .62 .14 .52 C .18 .46 .26 .44 .32 .46 C .34 .28 .52 .2 .64 .28 C .72 .32 .76 .42 .74 .5 C .9 .48 .96 .64 .86 .72 C .82 .74 .78 .74 .74 .74 Z",
  browser: "M .08 .2 H .92 V .82 H .08 Z M .08 .36 H .92 M .17 .28 h .04 M .27 .28 h .04 M .37 .28 h .04",
  mobile: "M .28 .1 H .72 V .9 H .28 Z M .42 .18 h .16 M .46 .8 h .08",
  lock: "M .2 .44 H .8 V .9 H .2 Z M .32 .44 V .3 C .32 .16 .68 .16 .68 .3 V .44 M .5 .58 V .74",
  key: "M .34 .5 m -.22 0 a .22 .22 0 1 0 .44 0 a .22 .22 0 1 0 -.44 0 M .56 .5 H .92 M .78 .5 V .68 M .9 .5 V .64",
  file: "M .24 .08 H .62 L .78 .26 V .92 H .24 Z M .62 .08 V .26 H .78 M .36 .48 h .3 M .36 .64 h .3",
  folder: "M .08 .24 H .42 L .5 .36 H .92 V .82 H .08 Z",
  gear: "M .5 .5 m -.26 0 a .26 .26 0 1 0 .52 0 a .26 .26 0 1 0 -.52 0 M .5 .5 m -.09 0 a .09 .09 0 1 0 .18 0 a .09 .09 0 1 0 -.18 0 M .5 .1 V .23 M .5 .77 V .9 M .1 .5 H .23 M .77 .5 H .9 M .22 .22 L .31 .31 M .69 .69 L .78 .78 M .78 .22 L .69 .31 M .31 .69 L .22 .78",
  mail: "M .08 .24 H .92 V .78 H .08 Z M .08 .24 L .5 .56 L .92 .24",
  link: "M .42 .6 L .58 .42 M .38 .38 L .26 .5 A .17 .17 0 0 0 .5 .74 L .58 .66 M .62 .62 L .74 .5 A .17 .17 0 0 0 .5 .26 L .42 .34",
  chart: "M .1 .9 V .1 M .1 .9 H .92 M .24 .9 V .56 H .38 V .9 M .46 .9 V .34 H .6 V .9 M .68 .9 V .48 H .82 V .9",
  shield: "M .5 .08 L .86 .22 V .5 C .86 .72 .7 .86 .5 .94 C .3 .86 .14 .72 .14 .5 V .22 Z",
  globe: "M .5 .5 m -.42 0 a .42 .42 0 1 0 .84 0 a .42 .42 0 1 0 -.84 0 M .08 .5 H .92 M .5 .08 C .68 .28 .68 .72 .5 .92 C .32 .72 .32 .28 .5 .08",
  terminal: "M .08 .18 H .92 V .82 H .08 Z M .22 .36 L .38 .5 L .22 .64 M .5 .66 h .24"
};

/** A symbol library the agent built with define_symbol, on top of the built-in names. */
export type SymbolLibrary = Record<string, string>;

/**
 * Points for one symbol. Built-in names win over defined ones, so "server" means the same thing on
 * every board; `path` draws a one-off symbol that was never named.
 */
export function iconSegments(name: string | undefined, x: number, y: number, size: number, symbols?: SymbolLibrary, path?: string): Array<Array<{ x: number; y: number; pressure: number }>> {
  const point = (px: number, py: number) => ({ x: x + px * size, y: y + py * size, pressure: .5 });
  const drawn = path ?? (name ? iconPaths[name as IconName] ?? symbols?.[name] : undefined);
  if (drawn) {
    const subpaths = parseSvgPath(drawn, 8);
    const fitted = fitSubpaths(subpaths, { x: 0, y: 0, width: 1, height: 1 });
    return fitted.map((subpath) => subpath.map((position) => point(position.x, position.y)));
  }
  if (name === "check") return [[point(.08, .52), point(.38, .82), point(.92, .16)]];
  if (name === "close") return [[point(.14, .14), point(.86, .86)], [point(.86, .14), point(.14, .86)]];
  if (name === "plus") return [[point(.5, .08), point(.5, .92)], [point(.08, .5), point(.92, .5)]];
  if (name === "minus") return [[point(.08, .5), point(.92, .5)]];
  if (name === "menu") return [[point(.08, .22), point(.92, .22)], [point(.08, .5), point(.92, .5)], [point(.08, .78), point(.92, .78)]];
  if (name === "search") return [[...Array.from({ length: 17 }, (_, index) => { const angle = index / 16 * Math.PI * 2; return point(.38 + Math.cos(angle) * .28, .38 + Math.sin(angle) * .28); })], [point(.58, .58), point(.92, .92)]];
  if (name === "user") return [[...Array.from({ length: 17 }, (_, index) => { const angle = index / 16 * Math.PI * 2; return point(.5 + Math.cos(angle) * .19, .28 + Math.sin(angle) * .19); })], [point(.12, .92), point(.18, .66), point(.5, .55), point(.82, .66), point(.88, .92)]];
  if (name === "arrow") return [[point(.1, .5), point(.9, .5)], [point(.62, .24), point(.9, .5), point(.62, .76)]];
  if (name === "star") return [[...Array.from({ length: 11 }, (_, index) => { const angle = -Math.PI / 2 + index * Math.PI / 5; const scale = index % 2 ? .21 : .46; return point(.5 + Math.cos(angle) * scale, .5 + Math.sin(angle) * scale); })]];
  if (name === "bulb") return [[...Array.from({ length: 13 }, (_, index) => { const angle = Math.PI * (.15 + index / 12 * 1.7); return point(.5 + Math.cos(angle) * .28, .42 - Math.sin(angle) * .28); }), point(.62, .72), point(.38, .72), point(.38, .42)], [point(.4, .84), point(.6, .84)]];
  if (name === "question") return [[point(.3, .3), point(.4, .16), point(.62, .16), point(.72, .3), point(.66, .46), point(.5, .56), point(.5, .68)], [point(.5, .84), point(.5, .88)]];
  if (name === "warning") return [[point(.5, .1), point(.94, .86), point(.06, .86), point(.5, .1)], [point(.5, .38), point(.5, .62)], [point(.5, .74), point(.5, .78)]];
  if (name === "clock") return [[...Array.from({ length: 21 }, (_, index) => { const angle = index / 20 * Math.PI * 2; return point(.5 + Math.cos(angle) * .42, .5 + Math.sin(angle) * .42); })], [point(.5, .26), point(.5, .5), point(.7, .62)]];
  return [[point(.5, .9), point(.12, .5), point(.16, .2), point(.38, .1), point(.5, .3), point(.62, .1), point(.84, .2), point(.88, .5), point(.5, .9)]];
}

/* ---------------------------------------------------- *
 * Annotation helpers: the marks people make when they   *
 * explain something on a board.                         *
 * ---------------------------------------------------- */

export type AnnotationKind = "brace" | "bubble" | "arc" | "dimension";
export const annotationKinds: AnnotationKind[] = ["brace", "bubble", "arc", "dimension"];
type AnnotationOperation = Extract<CanvasOperation, { type: "create_annotation" }>;

/** Ids an annotation creates: one drawn shape, plus its label when there is text. */
export function annotationElementIds(operation: AnnotationOperation, prefix: string): string[] {
  const base = operation.kind === "bubble" ? `${prefix}-box` : prefix;
  return operation.text?.trim() ? [base, `${prefix}-text`] : [base];
}

/**
 * Geometry for one annotation, written as SVG path data and read back through the same parser the
 * agent's own paths go through, so both take exactly one code path.
 */
export function annotationGeometry(operation: AnnotationOperation): { points: Array<{ x: number; y: number }>; closed: boolean; label: { x: number; y: number; width: number; align: "left" | "center" } | null } {
  const { x, y } = operation;
  const width = Math.max(8, operation.width); const height = Math.max(8, operation.height);
  const direction = operation.direction ?? (operation.kind === "brace" ? (height >= width ? "left" : "up") : operation.kind === "bubble" ? "down" : "up");
  const round = (value: number): number => Math.round(value * 100) / 100;
  const path = (parts: Array<string | number>): string => parts.map((part) => typeof part === "number" ? round(part) : part).join(" ");
  const parse = (d: string, closed: boolean, label: { x: number; y: number; width: number; align: "left" | "center" } | null) => ({ points: parseSvgPath(d).flat(), closed, label });

  if (operation.kind === "brace") {
    // A curly brace: two shoulders meeting at a tip that points at whatever is being called out.
    const vertical = direction === "left" || direction === "right";
    const depth = vertical ? width : height;
    const span = vertical ? height : width;
    const along = (fraction: number): number => (vertical ? y : x) + span * fraction;
    const across = (fraction: number): number => (vertical ? x : y) + (direction === "left" || direction === "up" ? depth * fraction : depth * (1 - fraction));
    const at = (fraction: number, level: number): [number, number] => vertical ? [across(level), along(fraction)] : [along(fraction), across(level)];
    const d = path(["M", ...at(0, 1), "Q", ...at(0, .35), ...at(.18, .35), "L", ...at(.4, .35), "Q", ...at(.5, .35), ...at(.5, 0),
      "Q", ...at(.5, .35), ...at(.6, .35), "L", ...at(.82, .35), "Q", ...at(1, .35), ...at(1, 1)]);
    // The tip points at the content, so the label belongs on the brace's back, never over it.
    const [tipX, tipY] = at(.5, 0);
    const label = operation.text?.trim()
      ? vertical
        ? { x: direction === "left" ? x + width + 12 : x - 220, y: tipY - 12, width: 208, align: "left" as const }
        : { x: tipX - 110, y: direction === "up" ? y + height + 10 : y - 34, width: 220, align: "center" as const }
      : null;
    return parse(d, false, label);
  }

  if (operation.kind === "arc") {
    // A bow drawn over or under a span, for "this whole part" gestures.
    const up = direction !== "down";
    const d = path(["M", x, up ? y + height : y, "Q", x + width / 2, up ? y - height * .35 : y + height * 1.35, x + width, up ? y + height : y]);
    const label = operation.text?.trim() ? { x: x + width / 2 - 110, y: up ? y - 30 : y + height + 8, width: 220, align: "center" as const } : null;
    return parse(d, false, label);
  }

  if (operation.kind === "dimension") {
    // A measured span: end ticks and one line, drawn in a single stroke.
    const tick = Math.max(8, Math.min(18, height / 2));
    const middle = y + height / 2;
    const d = path(["M", x, middle - tick, "L", x, middle + tick, "L", x, middle, "L", x + width, middle, "L", x + width, middle - tick, "L", x + width, middle + tick]);
    const label = operation.text?.trim() ? { x: x + width / 2 - 110, y: middle - tick - 26, width: 220, align: "center" as const } : null;
    return parse(d, false, label);
  }

  // Speech bubble: a rounded box with a tail pointing at what it is talking about.
  const radius = Math.min(18, width / 4, height / 4);
  const tail = Math.min(26, height / 3, width / 3);
  const horizontal = direction === "left" || direction === "right";
  const d = horizontal
    ? path(["M", x + radius, y, "L", x + width - radius, y, "Q", x + width, y, x + width, y + radius,
        ...(direction === "right" ? ["L", x + width, y + height / 2 - tail / 2, "L", x + width + tail, y + height / 2, "L", x + width, y + height / 2 + tail / 2] : []),
        "L", x + width, y + height - radius, "Q", x + width, y + height, x + width - radius, y + height,
        "L", x + radius, y + height, "Q", x, y + height, x, y + height - radius,
        ...(direction === "left" ? ["L", x, y + height / 2 + tail / 2, "L", x - tail, y + height / 2, "L", x, y + height / 2 - tail / 2] : []),
        "L", x, y + radius, "Q", x, y, x + radius, y, "Z"])
    : path(["M", x + radius, y,
        ...(direction === "up" ? ["L", x + width / 2 - tail / 2, y, "L", x + width / 2, y - tail, "L", x + width / 2 + tail / 2, y] : []),
        "L", x + width - radius, y, "Q", x + width, y, x + width, y + radius,
        "L", x + width, y + height - radius, "Q", x + width, y + height, x + width - radius, y + height,
        ...(direction === "down" ? ["L", x + width / 2 + tail / 2, y + height, "L", x + width / 2, y + height + tail, "L", x + width / 2 - tail / 2, y + height] : []),
        "L", x + radius, y + height, "Q", x, y + height, x, y + height - radius,
        "L", x, y + radius, "Q", x, y, x + radius, y, "Z"]);
  const padding = 14;
  return parse(d, true, operation.text?.trim() ? { x: x + padding, y: y + padding, width: width - padding * 2, align: "left" as const } : null);
}

/** Outline points for the shape kinds that compile to polygons instead of primitives. */
export function polygonShapePoints(kind: "diamond" | "triangle", x: number, y: number, width: number, height: number): InkPoint[] {
  const point = (px: number, py: number): InkPoint => ({ x: px, y: py, pressure: .5 });
  if (kind === "diamond") return [point(x + width / 2, y), point(x + width, y + height / 2), point(x + width / 2, y + height), point(x, y + height / 2)];
  return [point(x + width / 2, y), point(x + width, y + height), point(x, y + height)];
}

export function tableCellIds(operation: Extract<CanvasOperation, { type: "create_table" }>, prefix: string): string[] {
  const rows = Math.max(1, Math.min(20, Math.round(operation.rows))); const columns = Math.max(1, Math.min(12, Math.round(operation.columns))); const created: string[] = [];
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    created.push(`${prefix}-cell-${row}-${column}`);
    const value = row === 0 && operation.headers?.[column] ? operation.headers[column] : operation.cells?.[row * columns + column];
    if (value) created.push(`${prefix}-text-${row}-${column}`);
  }
  return created;
}

/** Every concrete element id an operation will create when it carries an explicit id. */
export function plannedElementIds(operation: CanvasOperation, symbols?: SymbolLibrary): string[] {
  const explicit = "id" in operation && typeof operation.id === "string" ? operation.id : undefined;
  if (!explicit) return [];
  switch (operation.type) {
    case "create_text": case "create_highlight": case "create_shape": case "create_arrow": case "create_stroke": case "create_polygon": case "connect": return [explicit];
    case "create_path": return operation.d ? parseSvgPath(operation.d).map((_, index) => `${explicit}-${index}`) : [explicit];
    case "create_annotation": return annotationElementIds(operation, explicit);
    case "create_note": return [`${explicit}-card`, `${explicit}-text`];
    case "create_callout": return operation.anchorId ? [`${explicit}-box`, `${explicit}-text`, `${explicit}-leader`] : [`${explicit}-box`, `${explicit}-text`];
    case "create_frame": return operation.title ? [`${explicit}-border`, `${explicit}-title`] : [`${explicit}-border`];
    case "create_table": return tableCellIds(operation, explicit);
    case "create_icon": return iconSegments(operation.name, 0, 0, 32, symbols, operation.d).map((_, index) => `${explicit}-${index}`);
    default: return [];
  }
}

/** Group ids an operation registers, so later operations may address the composite. */
export function plannedGroupIds(operation: CanvasOperation): string[] {
  if (operation.type === "group" && operation.groupId) return [operation.groupId];
  if (!("id" in operation) || typeof operation.id !== "string") return [];
  if (operation.type === "create_path") return operation.d && parseSvgPath(operation.d).length > 1 ? [operation.id] : [];
  return ["create_note", "create_frame", "create_table", "create_icon", "create_callout", "create_annotation"].includes(operation.type) ? [operation.id] : [];
}

/** Existing ids an operation reads or mutates. A missing target makes the operation a silent no-op. */
export function operationTargetIds(operation: CanvasOperation): string[] {
  const targets: string[] = [];
  if ("ids" in operation && Array.isArray(operation.ids)) targets.push(...operation.ids);
  if (["resize", "update_text", "update_points", "update_artboard", "fit_to_content"].includes(operation.type) && "id" in operation && typeof operation.id === "string") targets.push(operation.id);
  if (operation.type === "create_callout" && operation.anchorId) targets.push(operation.anchorId);
  if (operation.type === "connect") targets.push(operation.fromId, operation.toId);
  if (operation.type === "set_parent" && operation.parentId) targets.push(operation.parentId);
  if (operation.type === "ungroup" && operation.groupId) targets.push(operation.groupId);
  if (operation.type.startsWith("create_") && "parentId" in operation && typeof operation.parentId === "string") targets.push(operation.parentId);
  return targets;
}

/**
 * Where a creation operation would land, for the operations that place a block of content.
 * Free drawing, connectors, callouts, highlights and markers are deliberately left out: those are
 * meant to cross other things. Anything parented into a container is left out too, because the
 * container owns what is inside it.
 */
export function plannedBounds(operation: CanvasOperation): Bounds | null {
  if ("parentId" in operation && typeof operation.parentId === "string") return null;
  const box = (x: number, y: number, width: number, height: number): Bounds => ({ minX: x, minY: y, maxX: x + width, maxY: y + height });
  switch (operation.type) {
    case "create_text": {
      const width = operation.width ?? 260;
      return box(operation.x, operation.y, width, estimateTextHeight(operation.text, width, operation.fontSize ?? 20, { fontFamily: operation.fontFamily, fontWeight: operation.fontWeight }));
    }
    case "create_note": return box(operation.x, operation.y, operation.width ?? 220, operation.height ?? 140);
    case "create_table": case "create_frame": case "create_shape": return box(operation.x, operation.y, operation.width, operation.height);
    case "create_icon": return box(operation.x, operation.y, operation.size ?? 32, operation.size ?? 32);
    default: return null;
  }
}

export type PreflightResult = { ok: true } | { ok: false; error: "id_conflict" | "missing_target"; ids: string[]; instruction: string };

/**
 * Validates a whole batch before a single operation runs: no id collisions with the board or
 * within the batch, and every mutation target actually resolves (including objects created
 * earlier in the same batch).
 */
export function preflightOperations(operations: CanvasOperation[], existingElementIds: Iterable<string>, existingGroupIds: Iterable<string> = [], symbols: SymbolLibrary = {}): PreflightResult {
  const elementIds = new Set(existingElementIds);
  const groupIds = new Set(existingGroupIds);
  // Symbols defined earlier in this same batch count, so defining and stamping in one call works.
  const library: SymbolLibrary = { ...symbols };
  const conflicts: string[] = [];
  const missing: string[] = [];
  for (const operation of operations) {
    if (operation.type === "define_symbol") library[operation.name] = operation.d;
    for (const target of operationTargetIds(operation)) if (!elementIds.has(target) && !groupIds.has(target) && !missing.includes(target)) missing.push(target);
    for (const created of plannedElementIds(operation, library)) {
      if (elementIds.has(created)) { if (!conflicts.includes(created)) conflicts.push(created); }
      else elementIds.add(created);
    }
    for (const group of plannedGroupIds(operation)) groupIds.add(group);
    if (operation.type === "delete") for (const removed of operation.ids) elementIds.delete(removed);
  }
  if (conflicts.length) return { ok: false, error: "id_conflict", ids: conflicts.slice(0, 12), instruction: "These ids already exist on the board or repeat inside the batch. Use fresh ids; nothing was applied." };
  if (missing.length) return { ok: false, error: "missing_target", ids: missing.slice(0, 12), instruction: "These target ids do not exist on the board. Inspect the whiteboard again; nothing was applied." };
  return { ok: true };
}
