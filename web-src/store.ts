import { PageElement, elementBounds } from "../src/document";
import { beautifyStroke } from "../src/strokes";
import { measureTextBlock } from "./measure";
import { fitSubpaths, parseSvgPath } from "./path";
import { BoundsIndex } from "./occupancy";
import { AgentStyle } from "./compositions";
import { Bounds, CanvasOperation, ConnectorLanes, ConnectorRoute, WhiteboardDocument, CONNECTOR_LABEL_PADDING, annotationGeometry, boardBounds, boundsIntersect, boundsOverlapArea, cloneBoard, connectionRoute, elementSignature, emptyBoard, estimateTextHeight, iconSegments, migrateBoard, operationElement, polygonShapePoints, scaleElement, translateElement } from "./model";

const STORAGE_KEY = "smooth-whiteboard-v3";
/** How much undo history is worth carrying; images make a single step expensive. */
const MAX_HISTORY_BYTES = 24_000_000;
/** How far around a connector something still counts as being in its way. */
const CONNECTOR_MARGIN = 320;
const LEGACY_STORAGE_KEY = "smooth-whiteboard-v1";
const PRE_AGENT_STORAGE_KEY = "smooth-whiteboard-pre-agent-v1";

/**
 * "content" bumps the canvas revision an agent inspects; "metadata" persists session bookkeeping
 * (claim, plan, status, lease) without invalidating an inspected baseRevision.
 */
export type ChangeKind = "content" | "metadata";
/** "reset" refreshes the mutation baseline silently (import, clear, restore). */
export type ChangeSource = "human" | "agent" | "reset";
export interface ContentMutation { source: "human" | "agent"; changedIds: string[]; removedIds: string[]; removedRegions: Array<{ id: string; bounds: Bounds }> }

export class BoardStore extends EventTarget {
  document: WhiteboardDocument;
  /** Single place every human board mutation is observed, whichever UI handler caused it. */
  onContentMutation: ((mutation: ContentMutation) => void) | null = null;
  private undoStack: WhiteboardDocument[] = [];
  private redoStack: WhiteboardDocument[] = [];
  private agentBefore: WhiteboardDocument | null = null;
  private mutationBaseline = new Map<string, { signature: string; bounds: Bounds }>();
  private channel: BroadcastChannel | null = null;
  /** Told the shell when another tab edited this board while a turn was open here. */
  onRemoteBlocked?: () => void;

  constructor() {
    super();
    try { const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("smooth-whiteboard-v2") ?? localStorage.getItem(LEGACY_STORAGE_KEY) ?? "null") as unknown; this.document = migrateBoard(parsed) ?? emptyBoard(); }
    catch { this.document = emptyBoard(); }
    this.document.connections ??= {}; this.document.groups ??= {}; this.document.artboardIds ??= []; this.document.explanationSequences ??= []; this.document.sources ??= [];
    try { const snapshot = migrateBoard(JSON.parse(localStorage.getItem(PRE_AGENT_STORAGE_KEY) ?? "null") as unknown); if (snapshot && this.document.turn && ["working", "review"].includes(this.document.turn.status)) this.agentBefore = snapshot; }
    catch { this.agentBefore = null; }
    this.refreshConnections(); this.cleanGroups(); this.resetMutationBaseline();
    // Two tabs on one board used to overwrite each other in silence, and whoever saved last won.
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(STORAGE_KEY);
      this.channel.onmessage = (event) => this.receiveRemote(event.data as { revision?: number; document?: unknown } | null);
      // Outside a browser an open channel keeps the process alive; the test run must still end.
      (this.channel as unknown as { unref?: () => void }).unref?.();
    }
  }

  /**
   * Content from another tab is adopted when it is newer — but never while a turn is open here.
   * A proposal in flight belongs to this tab's session and must not be pulled out from under it.
   */
  private receiveRemote(message: { revision?: number; document?: unknown } | null): void {
    if (!message || typeof message.revision !== "number" || message.revision <= this.document.revision) return;
    const incoming = migrateBoard(message.document); if (!incoming) return;
    const turn = this.document.turn;
    if (turn && ["queued", "claimed", "planning", "working", "review"].includes(turn.status)) { this.onRemoteBlocked?.(); return; }
    this.document = cloneBoard(incoming);
    this.document.turn = turn ?? null;
    // History from a tab that is not this one is not ours to step back through.
    this.undoStack = []; this.redoStack = [];
    this.refreshConnections(); this.cleanGroups(); this.resetMutationBaseline();
    this.dispatchEvent(new Event("change"));
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  /**
   * How heavy a snapshot is, cheaply. Images live in the document as data URLs, so a photo makes
   * every step of the history cost megabytes; the stack is capped by weight as well as by count.
   */
  private weight(snapshot: WhiteboardDocument): number {
    let bytes = snapshot.elements.length * 200;
    for (const element of snapshot.elements) if (element.type === "image") bytes += element.dataUrl.length;
    return bytes;
  }

  checkpoint(): void {
    this.undoStack.push(cloneBoard(this.document));
    while (this.undoStack.length > 100) this.undoStack.shift();
    let carried = this.undoStack.reduce((total, snapshot) => total + this.weight(snapshot), 0);
    while (this.undoStack.length > 1 && carried > MAX_HISTORY_BYTES) carried -= this.weight(this.undoStack.shift()!);
    this.redoStack = [];
  }

  changed(kind: ChangeKind = "content", source: ChangeSource = "human"): void {
    this.refreshConnections(); this.cleanGroups();
    if (kind === "content") { this.document.revision += 1; this.trackMutation(source); }
    this.persist(STORAGE_KEY, this.document);
    this.channel?.postMessage({ revision: this.document.revision, document: this.document });
    this.dispatchEvent(new Event("change"));
  }

  /**
   * Saving must never take the drawing down with it. A full browser store used to throw out of
   * every single edit, which also skipped the change event, so the canvas quietly stopped
   * repainting and nothing ever said that the work was no longer being kept.
   */
  private persist(key: string, value: WhiteboardDocument): void {
    try { localStorage.setItem(key, JSON.stringify(value)); if (this.storageFailed) { this.storageFailed = false; this.onStorageChange?.(true); } }
    catch { if (!this.storageFailed) { this.storageFailed = true; this.onStorageChange?.(false); } }
  }

  private storageFailed = false;
  /** Told the shell when saving starts or stops working, so the human can be warned once. */
  onStorageChange?: (working: boolean) => void;

  /** Content revision the agent inspects; session bookkeeping never advances it. */
  contentRevision(): number { return this.document.revision; }

  resetMutationBaseline(): void {
    this.mutationBaseline = new Map(this.document.elements.map((element) => [element.id, { signature: elementSignature(element), bounds: elementBounds(element) }]));
  }

  private trackMutation(source: ChangeSource): void {
    const next = new Map<string, { signature: string; bounds: Bounds }>();
    const changedIds: string[] = [];
    for (const element of this.document.elements) {
      const signature = elementSignature(element); next.set(element.id, { signature, bounds: elementBounds(element) });
      const previous = this.mutationBaseline.get(element.id);
      if (!previous || previous.signature !== signature) changedIds.push(element.id);
    }
    // Relative order of surviving elements: catches reorder, which no value signature can see.
    const before = [...this.mutationBaseline.keys()].filter((id) => next.has(id));
    const after = this.document.elements.map((element) => element.id).filter((id) => this.mutationBaseline.has(id));
    for (const [index, id] of after.entries()) if (before[index] !== id && !changedIds.includes(id)) changedIds.push(id);
    const removedRegions: Array<{ id: string; bounds: Bounds }> = [];
    for (const [id, value] of this.mutationBaseline) if (!next.has(id)) removedRegions.push({ id, bounds: value.bounds });
    this.mutationBaseline = next;
    // Which elements the agent removed, so a rollback can bring exactly those back and leave
    // anything the human deleted in the meantime deleted.
    if (source === "agent") for (const region of removedRegions) this.agentRemovedIds.add(region.id);
    if (source === "reset" || (!changedIds.length && !removedRegions.length)) return;
    this.onContentMutation?.({ source, changedIds, removedIds: removedRegions.map((region) => region.id), removedRegions });
  }

  replace(document: WhiteboardDocument): void { this.agentBefore = null; localStorage.removeItem(PRE_AGENT_STORAGE_KEY); this.document = cloneBoard(document); this.resetMutationBaseline(); this.changed("content", "reset"); }

  // Undo/redo travel through canvas content only: the live turn and its lease are session state
  // and must not be resurrected or destroyed by a history step.
  undo(): boolean {
    const previous = this.undoStack.pop(); if (!previous) return false;
    const turn = this.document.turn;
    this.redoStack.push(cloneBoard(this.document)); this.document = previous; this.document.turn = turn; this.changed(); return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop(); if (!next) return false;
    const turn = this.document.turn;
    this.undoStack.push(cloneBoard(this.document)); this.document = next; this.document.turn = turn; this.changed(); return true;
  }

  beginAgentContribution(): void {
    if (!this.agentBefore) { this.agentBefore = cloneBoard(this.document); this.agentRemovedIds.clear(); this.persist(PRE_AGENT_STORAGE_KEY, this.agentBefore); }
    if (this.document.turn) this.document.turn.status = "working";
  }

  acceptAgentContribution(): void {
    this.agentBefore = null; this.agentRemovedIds.clear(); localStorage.removeItem(PRE_AGENT_STORAGE_KEY); if (this.document.turn) { this.document.turn.status = "complete"; this.document.turn.promptText = ""; this.document.turn.instructionInk = []; this.document.turn.agentMarkers = []; this.document.turn.pendingChangeIds = []; this.document.turn.leaseToken = undefined; } this.document.lastAgentRevision = this.document.revision; this.changed("metadata");
  }

  /**
   * Takes back the agent's proposal element by element instead of restoring the whole document.
   * The human may have drawn beside it while it was being made, and that work has to survive.
   */
  undoAgentContribution(): boolean {
    const before = this.agentBefore; if (!before) return false;
    const cancelledTurn = this.document.turn;
    const previous = new Map(before.elements.map((element) => [element.id, element]));
    const proposed = new Set(this.document.agentElementIds.filter((id) => !previous.has(id)));
    const touched = new Set(cancelledTurn?.pendingChangeIds ?? []);
    // Drop what the agent created, put back the pre-turn version of what it edited.
    this.document.elements = this.document.elements
      .filter((element) => !proposed.has(element.id))
      .map((element) => touched.has(element.id) && previous.has(element.id) ? structuredClone(previous.get(element.id)!) : element);
    // Restore what it deleted, in its original place in the stacking order.
    const present = new Set(this.document.elements.map((element) => element.id));
    for (const [index, element] of before.elements.entries()) {
      if (present.has(element.id) || !this.agentRemovedIds.has(element.id)) continue;
      this.document.elements.splice(Math.min(index, this.document.elements.length), 0, structuredClone(element));
    }
    this.document.agentElementIds = this.document.agentElementIds.filter((id) => !proposed.has(id));
    this.document.artboardIds = this.document.artboardIds.filter((id) => !proposed.has(id));
    this.document.groups = Object.fromEntries(Object.entries(this.document.groups ?? {}).map(([id, members]) => [id, members.filter((member) => !proposed.has(member))]).filter(([, members]) => members.length > 1));
    this.document.explanationSequences = before.explanationSequences ? structuredClone(before.explanationSequences) : this.document.explanationSequences;
    this.document.presentation = before.presentation ? structuredClone(before.presentation) : null;
    this.document.symbols = structuredClone(before.symbols ?? {});
    this.agentBefore = null; this.agentRemovedIds.clear(); localStorage.removeItem(PRE_AGENT_STORAGE_KEY);
    if (cancelledTurn) this.document.turn = { ...cancelledTurn, status: "cancelled", instructionInk: [], agentMarkers: [], pendingChangeIds: [], leaseToken: undefined };
    // The rollback removes agent content, not human work: refresh the baseline without reporting it as human feedback.
    this.changed("content", "agent"); return true;
  }

  hasAgentContribution(): boolean { return this.agentBefore !== null; }

  private agentRemovedIds = new Set<string>();

  groupIdFor(elementId: string): string | undefined { return Object.entries(this.document.groups ?? {}).find(([, members]) => members.includes(elementId))?.[0]; }

  selectionUnitCount(ids: string[]): number { return new Set(ids.map((id) => this.groupIdFor(id) ?? `element:${id}`)).size; }

  expandGroupIds(ids: string[]): string[] {
    const expanded = new Set(ids); const groups = this.document.groups ?? {};
    for (const id of ids) {
      // An id may address a group directly (agents see groupId in inspect output) or a member of one.
      if (groups[id]) groups[id].forEach((member) => expanded.add(member));
      const groupId = this.groupIdFor(id); if (groupId) groups[groupId]?.forEach((member) => expanded.add(member));
    }
    let changed = true; while (changed) { changed = false; for (const element of this.document.elements) if (element.parentId && expanded.has(element.parentId) && !expanded.has(element.id)) { expanded.add(element.id); changed = true; } }
    return [...expanded];
  }

  private operationUnits(ids: string[]): string[][] {
    const groups = this.document.groups ?? {}; const seen = new Set<string>(); const units: string[][] = [];
    for (const id of ids) {
      const groupId = this.groupIdFor(id); const key = groupId ? `group:${groupId}` : `element:${id}`; if (seen.has(key)) continue; seen.add(key);
      units.push(groupId ? [...(groups[groupId] ?? [])] : [id]);
    }
    return units;
  }

  private elementsFor(ids: string[]) { const wanted = new Set(ids); return this.document.elements.filter((element) => wanted.has(element.id)); }

  /** True when the element hangs under an artboard: designed UI, not a hand-drawn explanation. */
  onArtboard(parentId?: string): boolean {
    let current = parentId ? this.document.elements.find((element) => element.id === parentId) : undefined;
    for (let depth = 0; current && depth < 6; depth += 1) {
      if (current.artboard || current.semanticRole === "artboard") return true;
      current = current.parentId ? this.document.elements.find((element) => element.id === current!.parentId) : undefined;
    }
    return false;
  }

  /**
   * Agent text defaults to the hand-drawn look on the open canvas and to a clean sans face on an
   * artboard, so a UI mockup does not come out in marker pen. An explicit value always wins.
   */
  /**
   * The one place that decides how the agent's work looks: the human's Appearance setting, and
   * always clean on an artboard, where a hand-drawn mockup would be wrong.
   */
  agentStyle(parentId?: string): AgentStyle {
    const clean = this.document.settings.cleanStyle || this.onArtboard(parentId);
    return { fontFamily: clean ? "sans" : "handwriting", renderStyle: clean ? "clean" : "sketch" };
  }

  private agentTextStyle(parentId: string | undefined, fontFamily: "sans" | "serif" | "mono" | "handwriting" | undefined, renderStyle: "clean" | "sketch" | undefined): { fontFamily: "sans" | "serif" | "mono" | "handwriting"; renderStyle: "clean" | "sketch" } {
    const style = this.agentStyle(parentId);
    return { fontFamily: fontFamily ?? style.fontFamily, renderStyle: renderStyle ?? style.renderStyle };
  }

  /**
   * Redraws everything the agent made in the style that is set now. Only agent elements are touched —
   * your own writing is plain already — and note cards are re-fitted afterwards, because the two
   * faces do not have the same metrics and a taller text would otherwise hang out of its card.
   */
  restyleAgentContent(): void {
    const agentIds = new Set(this.document.agentElementIds);
    const artboards = new Set(this.document.artboardIds);
    const containers = ["artboard", "frame", "section", "screen"];
    for (const element of this.document.elements) {
      if (!agentIds.has(element.id) || artboards.has(element.id)) continue;
      // Symbols are drawn cleanly in both looks, so they are left exactly as they are.
      if (element.semanticRole === "icon") continue;
      const style = this.agentStyle(element.parentId);
      if (element.type === "text") {
        element.fontFamily = style.fontFamily; element.renderStyle = style.renderStyle;
        element.height = estimateTextHeight(element.text, element.width, element.fontSize, element);
      } else if (element.type === "shape" && !containers.includes(element.semanticRole ?? "")) {
        element.renderStyle = style.renderStyle;
      }
    }
    // The two faces do not wrap the same way, so any card its text now sticks out of has to grow.
    // Only grow: shrinking a card would move content a composition deliberately spaced out.
    for (const [groupId, members] of Object.entries(this.document.groups ?? {})) {
      void groupId;
      const elements = this.document.elements.filter((element) => members.includes(element.id));
      const card = elements.find((element) => element.type === "shape" && (element.kind === "rectangle" || element.kind === "ellipse") && !containers.includes(element.semanticRole ?? "") && !artboards.has(element.id));
      const texts = elements.filter((element) => element.type === "text");
      if (!card || !texts.length) continue;
      const bottom = Math.max(...texts.map((text) => elementBounds(text).maxY));
      if (bottom > elementBounds(card).maxY) this.applyOperation({ type: "fit_to_content", id: card.id, mode: "container" }, "human");
    }
  }

  applyOperation(operation: CanvasOperation, source: "human" | "agent"): string[] {
    const created: string[] = [];
    if (operation.type === "create_shape" && (operation.kind === "diamond" || operation.kind === "triangle")) {
      const element = operationElement({ type: "create_polygon", id: operation.id, points: polygonShapePoints(operation.kind, operation.x, operation.y, operation.width, operation.height), closed: true, color: operation.color, strokeWidth: operation.strokeWidth, fillColor: operation.fillColor, fillOpacity: operation.fillOpacity ?? (operation.filled ? .3 : 0) });
      element.semanticRole = operation.semanticRole; element.parentId = operation.parentId; element.name = operation.name;
      this.document.elements.push(element); created.push(element.id);
      if (source === "agent" && !this.document.agentElementIds.includes(element.id)) this.document.agentElementIds.push(element.id);
    } else if (operation.type === "create_text" || operation.type === "create_highlight" || operation.type === "create_shape" || operation.type === "create_arrow" || operation.type === "create_stroke" || operation.type === "create_polygon") {
      const normalized = operation.type === "create_text" && source === "agent" ? { ...operation, ...this.agentTextStyle(operation.parentId, operation.fontFamily, operation.renderStyle) } : operation;
      const element = operationElement(normalized);
      if ("renderStyle" in operation && operation.renderStyle && element.type !== "text") element.renderStyle = operation.renderStyle;
      this.document.elements.push(element); created.push(element.id);
      if (source === "agent" && !this.document.agentElementIds.includes(element.id)) this.document.agentElementIds.push(element.id);
    } else if (operation.type === "define_symbol") {
      const normalised = fitSubpaths(parseSvgPath(operation.d), { x: 0, y: 0, width: 1, height: 1 })
        .map((subpath) => "M " + subpath.map((point) => `${Math.round(point.x * 1000) / 1000} ${Math.round(point.y * 1000) / 1000}`).join(" L "))
        .join(" ");
      if (normalised) (this.document.symbols ??= {})[operation.name] = normalised;
    } else if (operation.type === "create_icon") {
      const prefix = operation.id ?? `icon-${crypto.randomUUID()}`; const members: string[] = [];
      for (const [index, points] of iconSegments(operation.name, operation.x, operation.y, Math.max(12, operation.size ?? 32), this.document.symbols, operation.d).entries()) {
        // Polygons, not strokes: a symbol has to keep its corners instead of being smoothed into a blob.
        const first = points[0]; const last = points[points.length - 1];
        const element = operationElement({ type: "create_polygon", id: `${prefix}-${index}`, points, closed: Math.hypot(last.x - first.x, last.y - first.y) < Math.max(1, (operation.size ?? 32) / 24), strokeWidth: Math.max(1.5, (operation.size ?? 32) / 14), color: operation.color ?? "#080808" }); element.semanticRole = "icon"; element.parentId = operation.parentId; element.name = operation.name ?? "symbol";
        this.document.elements.push(element); members.push(element.id); created.push(element.id); if (source === "agent") this.document.agentElementIds.push(element.id);
      }
      if (members.length > 1) (this.document.groups ??= {})[prefix] = members;
    } else if (operation.type === "create_agent_marker") {
      if (source === "agent" && this.document.turn) this.document.turn.agentMarkers.push({ id: operation.id ?? `agent-marker-${crypto.randomUUID()}`, kind: operation.points?.length ? "stroke" : "note", points: operation.points?.map((point) => ({ ...point, pressure: point.pressure ?? .5 })), x: operation.x, y: operation.y, text: operation.text?.slice(0, 300), anchorId: operation.anchorId });
    } else if (operation.type === "create_note") {
      const prefix = operation.id ?? `note-${crypto.randomUUID()}`; const width = Math.max(120, operation.width ?? 320);
      const noteFont = source === "agent" ? this.agentStyle(operation.parentId).fontFamily : "sans" as const;
      const needed = Math.round(measureTextBlock({ text: operation.text, width: Math.max(84, width - 36), fontSize: 24, blockStyle: operation.blockStyle, fontFamily: noteFont }).height + 36);
      const height = Math.max(90, needed, operation.height ?? 0);
      const shape = operationElement({ type: "create_shape", id: `${prefix}-card`, kind: "rectangle", x: operation.x, y: operation.y, width, height, color: operation.color ?? "#080808", strokeWidth: 2, fillColor: operation.fillColor ?? "#fff4b8", fillOpacity: 0.72, radius: 18 }); shape.renderStyle = operation.renderStyle ?? (source === "agent" ? this.agentStyle(operation.parentId).renderStyle : "clean"); shape.semanticRole = "note"; shape.parentId = operation.parentId;
      const text = operationElement({ type: "create_text", id: `${prefix}-text`, x: operation.x + 18, y: operation.y + 18, width: width - 36, text: operation.text, fontSize: 24, color: operation.color ?? "#080808", fontFamily: noteFont, blockStyle: operation.blockStyle ?? "body", renderStyle: shape.renderStyle, semanticRole: "note-body", parentId: operation.parentId });
      this.document.elements.push(shape, text); created.push(shape.id, text.id); (this.document.groups ??= {})[prefix] = [shape.id, text.id]; if (source === "agent") this.document.agentElementIds.push(shape.id, text.id);
    } else if (operation.type === "create_frame") {
      const prefix = operation.id ?? `frame-${crypto.randomUUID()}`; const shape = operationElement({ type: "create_shape", id: `${prefix}-border`, kind: "rectangle", x: operation.x, y: operation.y, width: operation.width, height: operation.height, color: operation.color ?? "#404040", strokeWidth: operation.artboardPreset ? 1.5 : 2, fillColor: operation.backgroundColor ?? "#ffffff", fillOpacity: operation.artboardPreset ? 1 : 0.04, radius: 24, lineStyle: operation.artboardPreset ? "solid" : "dashed", semanticRole: operation.semanticRole ?? (operation.artboardPreset ? "artboard" : "frame"), parentId: operation.parentId, name: operation.name ?? operation.title }); shape.renderStyle = operation.renderStyle; if (operation.artboardPreset) shape.artboard = { preset: operation.artboardPreset, backgroundColor: operation.backgroundColor ?? "#ffffff", clipContent: operation.clipContent ?? false }; this.document.elements.push(shape); created.push(shape.id);
      if (shape.artboard && !this.document.artboardIds.includes(shape.id)) this.document.artboardIds.push(shape.id);
      if (operation.title) { const label = operationElement({ type: "create_text", id: `${prefix}-title`, x: operation.x + 18, y: operation.y + 12, width: operation.width - 36, text: operation.title, fontSize: 28, color: operation.color ?? "#080808", fontFamily: source === "agent" ? "handwriting" : "sans", fontWeight: 700, blockStyle: "heading-2", semanticRole: "frame-title", parentId: shape.id }); this.document.elements.push(label); created.push(label.id); }
      (this.document.groups ??= {})[prefix] = [...created]; if (source === "agent") this.document.agentElementIds.push(...created);
    } else if (operation.type === "create_table") {
      const prefix = operation.id ?? `table-${crypto.randomUUID()}`; const rows = Math.max(1, Math.min(20, Math.round(operation.rows))); const columns = Math.max(1, Math.min(12, Math.round(operation.columns))); const cellWidth = operation.width / columns; const cellHeight = operation.height / rows;
      for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) { const index = row * columns + column; const cell = operationElement({ type: "create_shape", id: `${prefix}-cell-${row}-${column}`, kind: "rectangle", x: operation.x + column * cellWidth, y: operation.y + row * cellHeight, width: cellWidth, height: cellHeight, color: operation.color ?? "#080808", strokeWidth: 1.5, fillColor: row === 0 && operation.headers?.length ? (operation.fillColor ?? "#e9e9e9") : "#ffffff", fillOpacity: row === 0 && operation.headers?.length ? 0.7 : 0, radius: 0 }); cell.renderStyle = operation.renderStyle; cell.semanticRole = "table-cell"; this.document.elements.push(cell); created.push(cell.id); const value = row === 0 && operation.headers?.[column] ? operation.headers[column] : operation.cells?.[index]; if (value) { const label = operationElement({ type: "create_text", id: `${prefix}-text-${row}-${column}`, x: operation.x + column * cellWidth + 8, y: operation.y + row * cellHeight + 8, width: cellWidth - 16, text: value, fontSize: Math.min(22, cellHeight * 0.42), fontFamily: source === "agent" ? "handwriting" : "sans", fontWeight: row === 0 ? 700 : 400, blockStyle: row === 0 ? "heading-3" : "body", semanticRole: "table-text" }); this.document.elements.push(label); created.push(label.id); } }
      (this.document.groups ??= {})[prefix] = [...created]; if (source === "agent") this.document.agentElementIds.push(...created);
    } else if (operation.type === "highlight_text") {
      const wanted = new Set(this.expandGroupIds(operation.ids));
      for (const text of this.document.elements.filter((element): element is Extract<PageElement, { type: "text" }> => element.type === "text" && wanted.has(element.id))) {
        const padding = Math.max(0, operation.padding ?? 6); const height = (text.height ?? text.fontSize * 1.2) + padding * 2;
        const highlight = operationElement({ type: "create_highlight", x: text.x - padding, y: text.baseline - text.fontSize + height / 2 - padding, width: text.width + padding * 2, size: height, color: operation.color ?? "#ffd84d", opacity: operation.opacity ?? 0.24 });
        const textIndex = this.document.elements.findIndex((element) => element.id === text.id); this.document.elements.splice(Math.max(0, textIndex), 0, highlight); created.push(highlight.id);
        if (source === "agent") this.document.agentElementIds.push(highlight.id);
      }
    } else if (operation.type === "translate") {
      const expanded = this.expandGroupIds(operation.ids); this.elementsFor(expanded).forEach((element) => translateElement(element, operation.dx, operation.dy));
    } else if (operation.type === "resize") {
      const ids = this.expandGroupIds([operation.id]); const elements = this.elementsFor(ids); const from = boardBounds(elements);
      if (from) { const to = { minX: operation.x, minY: operation.y, maxX: operation.x + Math.max(8, operation.width), maxY: operation.y + Math.max(8, operation.height) }; elements.forEach((element) => scaleElement(element, from, to)); }
    } else if (operation.type === "update_text") {
      const element = this.document.elements.find((candidate) => candidate.id === operation.id); if (element?.type === "text") { element.text = operation.text; element.height = estimateTextHeight(element.text, element.width, element.fontSize, element); }
    } else if (operation.type === "update_points") {
      const element = this.document.elements.find((candidate) => candidate.id === operation.id); if (element?.type === "stroke" || element?.type === "shape" || element?.type === "highlight") element.points = operation.points.map((point) => ({ ...point, pressure: point.pressure ?? 0.5 }));
    } else if (operation.type === "update_style") {
      const expanded = this.expandGroupIds(operation.ids);
      if (operation.route) for (const id of expanded) { const connection = (this.document.connections ??= {})[id]; if (connection) connection.route = operation.route; }
      for (const element of this.elementsFor(expanded)) {
        if (operation.color && "color" in element) element.color = operation.color;
        if (operation.opacity !== undefined) element.opacity = Math.max(0, Math.min(1, operation.opacity));
        if (operation.renderStyle) element.renderStyle = operation.renderStyle;
        if (element.type === "highlight" && operation.opacity !== undefined) element.opacity = Math.max(0, Math.min(1, operation.opacity));
        if (element.type === "stroke" || element.type === "shape") {
          if (operation.strokeWidth !== undefined) element.size = Math.max(0.5, Math.min(32, operation.strokeWidth));
          if (element.type === "shape") {
            if (operation.fillColor) element.fillColor = operation.fillColor; if (operation.fillOpacity !== undefined) element.fillOpacity = Math.max(0, Math.min(1, operation.fillOpacity)); if (operation.radius !== undefined && element.kind === "rectangle") element.radius = Math.max(0, operation.radius);
            if (operation.lineStyle) element.lineStyle = operation.lineStyle;
            if (operation.arrowHeads && element.kind === "arrow") { element.startArrow = operation.arrowHeads === "start" || operation.arrowHeads === "both"; element.endArrow = operation.arrowHeads !== "start"; }
          }
        } else if (element.type === "text") {
          if (operation.fontSize !== undefined) element.fontSize = Math.max(10, Math.min(180, operation.fontSize));
          if (operation.fontFamily) element.fontFamily = operation.fontFamily; if (operation.fontWeight) element.fontWeight = operation.fontWeight; if (operation.fontStyle) element.fontStyle = operation.fontStyle; if (operation.textDecoration) element.textDecoration = operation.textDecoration; if (operation.textAlign) element.textAlign = operation.textAlign; if (operation.blockStyle) element.blockStyle = operation.blockStyle; if (operation.highlightColor !== undefined) element.highlightColor = operation.highlightColor || undefined;
          element.height = estimateTextHeight(element.text, element.width, element.fontSize, element);
        }
      }
    } else if (operation.type === "set_locked") {
      const expanded = this.expandGroupIds(operation.ids); this.elementsFor(expanded).forEach((element) => { element.locked = operation.locked; });
    } else if (operation.type === "reorder") {
      const expanded = this.expandGroupIds(operation.ids); const selected = this.elementsFor(expanded); const rest = this.document.elements.filter((element) => !expanded.includes(element.id));
      this.document.elements = operation.direction === "front" ? [...rest, ...selected] : [...selected, ...rest];
    } else if (operation.type === "connect") {
      const from = this.document.elements.find((element) => element.id === operation.fromId); const to = this.document.elements.find((element) => element.id === operation.toId);
      if (from && to) {
        const route = connectionRoute(from, to, operation.route ?? "straight"); const arrow = operationElement({ type: "create_arrow", id: operation.id, from: route[0], to: route.at(-1)!, color: operation.color, strokeWidth: operation.strokeWidth });
        if (arrow.type === "shape") arrow.points = route;
        this.document.elements.push(arrow); created.push(arrow.id); if (source === "agent") this.document.agentElementIds.push(arrow.id);
        const connection = { fromId: from.id, toId: to.id, labelId: undefined as string | undefined, route: operation.route ?? "straight" as ConnectorRoute };
        if (operation.label) {
          const fontSize = 16; const width = Math.max(96, Math.min(260, operation.label.length * 8.5 + 20)); const middle = route[Math.floor(route.length / 2)];
          const label = operationElement({ type: "create_text", x: middle.x - width / 2, y: middle.y - fontSize / 2, width, fontSize, text: operation.label, fontFamily: source === "agent" ? "handwriting" : "sans" });
          this.document.elements.push(label); created.push(label.id); if (source === "agent") this.document.agentElementIds.push(label.id);
          connection.labelId = label.id;
        }
        (this.document.connections ??= {})[arrow.id] = connection;
      }
    } else if (operation.type === "align") {
      const units = this.operationUnits(operation.ids).map((ids) => ({ ids, bounds: boardBounds(this.elementsFor(ids)) })).filter((unit): unit is { ids: string[]; bounds: NonNullable<ReturnType<typeof boardBounds>> } => Boolean(unit.bounds));
      const total = boardBounds(this.elementsFor(this.expandGroupIds(operation.ids))); if (total) for (const unit of units) {
        let dx = 0; let dy = 0; const box = unit.bounds;
        if (operation.alignment === "left") dx = total.minX - box.minX; else if (operation.alignment === "center-x") dx = (total.minX + total.maxX - box.minX - box.maxX) / 2; else if (operation.alignment === "right") dx = total.maxX - box.maxX;
        else if (operation.alignment === "top") dy = total.minY - box.minY; else if (operation.alignment === "center-y") dy = (total.minY + total.maxY - box.minY - box.maxY) / 2; else dy = total.maxY - box.maxY;
        this.elementsFor(unit.ids).forEach((element) => translateElement(element, dx, dy));
      }
    } else if (operation.type === "distribute") {
      const horizontal = operation.axis === "horizontal"; const units = this.operationUnits(operation.ids).map((ids) => ({ ids, bounds: boardBounds(this.elementsFor(ids)) })).filter((unit): unit is { ids: string[]; bounds: NonNullable<ReturnType<typeof boardBounds>> } => Boolean(unit.bounds)).sort((left, right) => horizontal ? left.bounds.minX - right.bounds.minX : left.bounds.minY - right.bounds.minY);
      if (units.length > 2) {
        const sizes = units.map((unit) => horizontal ? unit.bounds.maxX - unit.bounds.minX : unit.bounds.maxY - unit.bounds.minY); const first = horizontal ? units[0].bounds.minX : units[0].bounds.minY; const lastEnd = horizontal ? units.at(-1)!.bounds.maxX : units.at(-1)!.bounds.maxY;
        const gap = operation.gap ?? Math.max(0, (lastEnd - first - sizes.reduce((sum, size) => sum + size, 0)) / (units.length - 1)); let cursor = first;
        for (const [index, unit] of units.entries()) { const current = horizontal ? unit.bounds.minX : unit.bounds.minY; const delta = cursor - current; this.elementsFor(unit.ids).forEach((element) => translateElement(element, horizontal ? delta : 0, horizontal ? 0 : delta)); cursor += sizes[index] + gap; }
      }
    } else if (operation.type === "duplicate") {
      const originals = this.expandGroupIds(operation.ids); const idMap = new Map<string, string>(); const offsetX = operation.dx ?? 28; const offsetY = operation.dy ?? 28;
      for (const element of this.elementsFor(originals)) { const copy = structuredClone(element); const nextId = `${element.type}-${crypto.randomUUID()}`; idMap.set(element.id, nextId); copy.id = nextId; translateElement(copy, offsetX, offsetY); this.document.elements.push(copy); created.push(copy.id); if (source === "agent") this.document.agentElementIds.push(copy.id); }
      for (const [groupId, members] of Object.entries(this.document.groups ?? {})) if (members.every((id) => idMap.has(id))) (this.document.groups ??= {})[`${groupId}-${crypto.randomUUID()}`] = members.map((id) => idMap.get(id)!);
      for (const [arrowId, connection] of Object.entries(this.document.connections ?? {})) if (idMap.has(arrowId) && idMap.has(connection.fromId) && idMap.has(connection.toId)) (this.document.connections ??= {})[idMap.get(arrowId)!] = { fromId: idMap.get(connection.fromId)!, toId: idMap.get(connection.toId)!, labelId: connection.labelId ? idMap.get(connection.labelId) : undefined };
    } else if (operation.type === "group") {
      const members = [...new Set(operation.ids)].filter((id) => this.document.elements.some((element) => element.id === id));
      for (const [groupId, existing] of Object.entries(this.document.groups ?? {})) { const remaining = existing.filter((id) => !members.includes(id)); if (remaining.length > 1) (this.document.groups ?? {})[groupId] = remaining; else delete (this.document.groups ?? {})[groupId]; }
      if (members.length > 1) (this.document.groups ??= {})[operation.groupId ?? `group-${crypto.randomUUID()}`] = members;
    } else if (operation.type === "ungroup") {
      if (operation.groupId) delete (this.document.groups ?? {})[operation.groupId];
      if (operation.ids) for (const [groupId, members] of Object.entries(this.document.groups ?? {})) if (members.some((id) => operation.ids!.includes(id))) delete (this.document.groups ?? {})[groupId];
    } else if (operation.type === "set_parent") {
      const parent = operation.parentId ? this.document.elements.find((element) => element.id === operation.parentId) : undefined; if (operation.parentId && !parent) return created;
      for (const element of this.elementsFor(this.expandGroupIds(operation.ids))) if (element.id !== operation.parentId) element.parentId = operation.parentId;
    } else if (operation.type === "update_artboard") {
      const element = this.document.elements.find((candidate) => candidate.id === operation.id); if (element?.type === "shape" && (element.artboard || element.semanticRole === "artboard")) { element.semanticRole = "artboard"; element.name = operation.name ?? element.name; element.artboard = { preset: operation.preset ?? element.artboard?.preset ?? "custom", backgroundColor: operation.backgroundColor ?? element.artboard?.backgroundColor ?? "#ffffff", clipContent: operation.clipContent ?? element.artboard?.clipContent ?? false }; element.fillColor = element.artboard.backgroundColor; element.fillOpacity = 1; if (!this.document.artboardIds.includes(element.id)) this.document.artboardIds.push(element.id); }
    } else if (operation.type === "create_path" && operation.d) {
      // SVG path data: models write it well, and it lands here as ordinary editable geometry.
      const prefix = operation.id ?? `path-${crypto.randomUUID()}`; const members: string[] = [];
      const subpaths = fitSubpaths(parseSvgPath(operation.d), { x: operation.x ?? 0, y: operation.y ?? 0, width: operation.width, height: operation.height });
      for (const [index, subpath] of subpaths.entries()) {
        const first = subpath[0]; const last = subpath[subpath.length - 1];
        const element = operationElement({
          type: "create_polygon", id: `${prefix}-${index}`, points: subpath.map((point) => ({ x: point.x, y: point.y, pressure: .5 })),
          closed: operation.closed ?? (Math.hypot(last.x - first.x, last.y - first.y) < 1), color: operation.color, strokeWidth: operation.strokeWidth, fillColor: operation.fillColor, fillOpacity: operation.fillOpacity
        });
        element.renderStyle = operation.renderStyle;
        this.document.elements.push(element); members.push(element.id); created.push(element.id);
        if (source === "agent") this.document.agentElementIds.push(element.id);
      }
      if (members.length > 1) (this.document.groups ??= {})[prefix] = members;
    } else if (operation.type === "create_annotation") {
      const prefix = operation.id ?? `annotation-${crypto.randomUUID()}`;
      const geometry = annotationGeometry(operation);
      const style = source === "agent" ? this.agentTextStyle(undefined, undefined, operation.renderStyle) : { fontFamily: "sans" as const, renderStyle: operation.renderStyle ?? "clean" as const };
      const bubble = operation.kind === "bubble";
      const shape = operationElement({
        type: "create_polygon", id: bubble ? `${prefix}-box` : prefix, points: geometry.points.map((point) => ({ x: point.x, y: point.y, pressure: .5 })), closed: geometry.closed,
        color: operation.color ?? "#080808", strokeWidth: operation.strokeWidth ?? 2, fillColor: bubble ? "#ffffff" : undefined, fillOpacity: bubble ? 1 : 0
      });
      shape.renderStyle = style.renderStyle; shape.semanticRole = `annotation-${operation.kind}`;
      this.document.elements.push(shape); created.push(shape.id);
      if (source === "agent") this.document.agentElementIds.push(shape.id);
      if (geometry.label) {
        const label = operationElement({
          type: "create_text", id: `${prefix}-text`, x: geometry.label.x, y: geometry.label.y, width: geometry.label.width, text: operation.text!.trim(),
          fontSize: Math.max(12, Math.min(48, operation.fontSize ?? 18)), color: operation.color ?? "#080808", fontFamily: style.fontFamily, renderStyle: style.renderStyle,
          textAlign: geometry.label.align, semanticRole: `annotation-${operation.kind}-text`
        });
        this.document.elements.push(label); created.push(label.id);
        if (source === "agent") this.document.agentElementIds.push(label.id);
        (this.document.groups ??= {})[prefix] = [...created];
      }
    } else if (operation.type === "create_path") {
      // Models emit coarse points: bow turns two points into an arc, smoothing makes the rest look drawn.
      let points = (operation.points ?? []).map((point) => ({ x: point.x, y: point.y, pressure: .5 }));
      if (points.length === 2 && operation.bow) {
        const [start, end] = points; const dx = end.x - start.x; const dy = end.y - start.y; const length = Math.max(1, Math.hypot(dx, dy));
        const control = { x: (start.x + end.x) / 2 - dy / length * operation.bow, y: (start.y + end.y) / 2 + dx / length * operation.bow };
        points = Array.from({ length: 17 }, (_, index) => { const t = index / 16; const inverse = 1 - t; return { x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x, y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y, pressure: .5 }; });
      }
      if (operation.smooth !== false && points.length > 3) points = beautifyStroke(points, .16);
      const element = operationElement({ type: "create_polygon", id: operation.id, points, closed: operation.closed === true, color: operation.color, strokeWidth: operation.strokeWidth, fillColor: operation.fillColor, fillOpacity: operation.fillOpacity });
      element.renderStyle = operation.renderStyle;
      this.document.elements.push(element); created.push(element.id);
      if (source === "agent") this.document.agentElementIds.push(element.id);
    } else if (operation.type === "create_callout") {
      const prefix = operation.id ?? `callout-${crypto.randomUUID()}`; const width = Math.max(120, operation.width ?? 260); const fontSize = Math.max(12, Math.min(48, operation.fontSize ?? 18)); const padding = 14;
      const calloutStyle = source === "agent" ? this.agentTextStyle(undefined, undefined, operation.renderStyle) : { fontFamily: "sans" as const, renderStyle: operation.renderStyle ?? "clean" as const };
      const measured = measureTextBlock({ text: operation.text, width: width - padding * 2, fontSize, fontFamily: calloutStyle.fontFamily });
      const box = operationElement({ type: "create_shape", id: `${prefix}-box`, kind: "rectangle", x: operation.x, y: operation.y, width, height: Math.round(measured.height + padding * 2), color: operation.color ?? "#080808", strokeWidth: 2, fillColor: operation.fillColor ?? "#ffffff", fillOpacity: 1, radius: 14 });
      box.renderStyle = calloutStyle.renderStyle; box.semanticRole = "callout";
      const label = operationElement({ type: "create_text", id: `${prefix}-text`, x: operation.x + padding, y: operation.y + padding, width: width - padding * 2, text: operation.text, fontSize, color: operation.color ?? "#080808", fontFamily: calloutStyle.fontFamily, renderStyle: calloutStyle.renderStyle, semanticRole: "callout-text" });
      this.document.elements.push(box, label); created.push(box.id, label.id);
      const anchor = operation.anchorId ? this.document.elements.find((element) => element.id === operation.anchorId) : undefined;
      if (anchor) {
        const route = connectionRoute(box, anchor, "straight");
        const leader = operationElement({ type: "create_arrow", id: `${prefix}-leader`, from: route[0], to: route.at(-1)!, color: operation.color ?? "#404040", strokeWidth: 1.8 });
        this.document.elements.push(leader); created.push(leader.id);
      }
      (this.document.groups ??= {})[prefix] = [...created];
      if (source === "agent") this.document.agentElementIds.push(...created);
    } else if (operation.type === "auto_layout") {
      const units = this.operationUnits(operation.ids).map((ids) => ({ ids, bounds: boardBounds(this.elementsFor(ids)) })).filter((unit): unit is { ids: string[]; bounds: NonNullable<ReturnType<typeof boardBounds>> } => Boolean(unit.bounds));
      const start = boardBounds(this.elementsFor(this.expandGroupIds(operation.ids)));
      if (units.length > 1 && start) {
        const gap = Math.max(0, operation.gap ?? 28);
        const columns = operation.direction === "row" ? units.length : operation.direction === "column" ? 1 : Math.max(1, Math.round(operation.columns ?? Math.ceil(Math.sqrt(units.length))));
        const columnWidths: number[] = []; const rowHeights: number[] = [];
        units.forEach((unit, index) => {
          const column = index % columns; const row = Math.floor(index / columns);
          columnWidths[column] = Math.max(columnWidths[column] ?? 0, unit.bounds.maxX - unit.bounds.minX);
          rowHeights[row] = Math.max(rowHeights[row] ?? 0, unit.bounds.maxY - unit.bounds.minY);
        });
        const offset = (sizes: number[], index: number): number => sizes.slice(0, index).reduce((total, size) => total + size + gap, 0);
        units.forEach((unit, index) => {
          const column = index % columns; const row = Math.floor(index / columns);
          const height = unit.bounds.maxY - unit.bounds.minY; const slack = (rowHeights[row] ?? height) - height;
          const cross = operation.align === "center" ? slack / 2 : operation.align === "end" ? slack : 0;
          const dx = start.minX + offset(columnWidths, column) - unit.bounds.minX;
          const dy = start.minY + offset(rowHeights, row) + cross - unit.bounds.minY;
          this.elementsFor(unit.ids).forEach((element) => translateElement(element, dx, dy));
        });
      }
    } else if (operation.type === "fit_to_content") {
      const target = this.document.elements.find((element) => element.id === operation.id);
      const padding = Math.max(0, operation.padding ?? 18);
      const mode = operation.mode ?? (target?.type === "text" ? "text" : "container");
      if (target?.type === "text" && mode === "text") target.height = estimateTextHeight(target.text, target.width, target.fontSize, target);
      else if (target?.type === "shape" && (target.kind === "rectangle" || target.kind === "ellipse")) {
        const groupId = this.groupIdFor(target.id); const members = groupId ? this.document.groups?.[groupId] ?? [] : [];
        const texts = this.document.elements.filter((element): element is Extract<PageElement, { type: "text" }> => element.type === "text" && (element.parentId === target.id || members.includes(element.id)));
        const box = boardBounds([target]);
        if (texts.length && box) {
          const bottom = texts.reduce((lowest, text) => { text.height = estimateTextHeight(text.text, text.width, text.fontSize, text); return Math.max(lowest, text.baseline - text.fontSize + text.height); }, box.minY);
          const height = Math.max(40, bottom - box.minY + padding);
          target.points = [{ x: box.minX, y: box.minY, pressure: .5 }, { x: box.maxX, y: box.minY + height, pressure: .5 }];
        }
      }
    } else if (operation.type === "present_step") {
      const sequence = operation.sequenceId ? this.document.explanationSequences.find((candidate) => candidate.id === operation.sequenceId) : this.document.explanationSequences[0];
      if (sequence?.steps.length) this.document.presentation = { sequenceId: sequence.id, index: Math.max(0, Math.min(sequence.steps.length - 1, Math.round(operation.index))) };
    } else if (operation.type === "set_explanation_sequence") {
      const index = this.document.explanationSequences.findIndex((sequence) => sequence.id === operation.sequence.id); const copy = structuredClone(operation.sequence); if (index >= 0) this.document.explanationSequences[index] = copy; else this.document.explanationSequences.push(copy);
    } else {
      const expanded = this.expandGroupIds(operation.ids); this.document.elements = this.document.elements.filter((element) => !expanded.includes(element.id));
      this.document.agentElementIds = this.document.agentElementIds.filter((id) => !expanded.includes(id));
      this.document.artboardIds = this.document.artboardIds.filter((id) => !expanded.includes(id));
      this.document.explanationSequences = this.document.explanationSequences.map((sequence) => ({ ...sequence, steps: sequence.steps.map((step) => ({ ...step, focusElementIds: step.focusElementIds.filter((id) => !expanded.includes(id)), revealElementIds: step.revealElementIds.filter((id) => !expanded.includes(id)) })) })).filter((sequence) => sequence.steps.some((step) => step.focusElementIds.length || step.revealElementIds.length));
    }
    return created;
  }

  /**
   * Connectors that would run down the same corridor are spread across parallel lanes, so two
   * arrows between the same pair of boxes never sit on top of each other with their labels stacked.
   */
  private connectorLanes(connections: Record<string, { fromId: string; toId: string; route?: ConnectorRoute }>): Map<string, ConnectorLanes> {
    const corridors = new Map<string, string[]>();
    const sides = new Map<string, Array<{ arrowId: string; end: "from" | "to" }>>();
    for (const [arrowId, connection] of Object.entries(connections)) {
      if ((connection.route ?? "straight") === "straight") continue;
      const from = this.document.elements.find((element) => element.id === connection.fromId);
      const to = this.document.elements.find((element) => element.id === connection.toId);
      if (!from || !to) continue;
      const a = elementBounds(from); const b = elementBounds(to);
      const horizontal = Math.abs((b.minX + b.maxX) / 2 - (a.minX + a.maxX) / 2) >= Math.abs((b.minY + b.maxY) / 2 - (a.minY + a.maxY) / 2);
      const middle = horizontal ? ((a.minX + a.maxX) / 2 + (b.minX + b.maxX) / 2) / 2 : ((a.minY + a.maxY) / 2 + (b.minY + b.maxY) / 2) / 2;
      corridors.set(`${horizontal ? "h" : "v"}:${Math.round(middle / 60)}`, [...(corridors.get(`${horizontal ? "h" : "v"}:${Math.round(middle / 60)}`) ?? []), arrowId]);
      // Which side of which box each end leaves from: everything meeting there has to share it.
      const fromSide = horizontal ? ((b.minX + b.maxX) / 2 > (a.minX + a.maxX) / 2 ? "e" : "w") : ((b.minY + b.maxY) / 2 > (a.minY + a.maxY) / 2 ? "s" : "n");
      const toSide = horizontal ? ((a.minX + a.maxX) / 2 > (b.minX + b.maxX) / 2 ? "e" : "w") : ((a.minY + a.maxY) / 2 > (b.minY + b.maxY) / 2 ? "s" : "n");
      const push = (key: string, end: "from" | "to"): void => { sides.set(key, [...(sides.get(key) ?? []), { arrowId, end }]); };
      push(`${connection.fromId}:${fromSide}`, "from");
      push(`${connection.toId}:${toSide}`, "to");
    }
    const lanes = new Map<string, ConnectorLanes>();
    const set = (arrowId: string, patch: ConnectorLanes): void => { lanes.set(arrowId, { ...lanes.get(arrowId), ...patch }); };
    for (const shared of corridors.values()) {
      const sorted = [...shared].sort();
      sorted.forEach((arrowId, index) => set(arrowId, { corridor: index - (sorted.length - 1) / 2 }));
    }
    for (const attached of sides.values()) {
      const sorted = [...attached].sort((left, right) => left.arrowId.localeCompare(right.arrowId));
      sorted.forEach((entry, index) => set(entry.arrowId, { [entry.end]: index - (sorted.length - 1) / 2 }));
    }
    return lanes;
  }

  private refreshConnections(): void {
    const connections = this.document.connections ??= {};
    const lanes = this.connectorLanes(connections);
    const placedLabels: Bounds[] = [];
    // Built once for the whole pass: looking an element up, its box, and what sits near a box.
    // Doing any of these per connector is what made a large board take seconds per stroke.
    const byId = new Map(this.document.elements.map((element) => [element.id, element]));
    const boxOfElement = new Map(this.document.elements.map((element) => [element.id, elementBounds(element)]));
    const index = new BoundsIndex(this.document.elements
      .filter((element) => element.type !== "text" && !(element.type === "shape" && (element.kind === "arrow" || element.kind === "line")) && !element.artboard)
      .map((element) => ({ id: element.id, bounds: boxOfElement.get(element.id)! })));
    for (const [arrowId, connection] of Object.entries(connections)) {
      const from = byId.get(connection.fromId);
      const to = byId.get(connection.toId);
      const arrow = byId.get(arrowId);
      if (!from || !to || arrow?.type !== "shape" || arrow.kind !== "arrow") {
        const removeIds = new Set([arrowId, connection.labelId].filter((id): id is string => Boolean(id)));
        this.document.elements = this.document.elements.filter((element) => !removeIds.has(element.id));
        this.document.agentElementIds = this.document.agentElementIds.filter((id) => !removeIds.has(id));
        delete connections[arrowId]; continue;
      }
      const fromBox = boxOfElement.get(from.id)!; const toBox = boxOfElement.get(to.id)!;
      // Only what lies around this connector can get in its way, so only that is looked at.
      const span = { minX: Math.min(fromBox.minX, toBox.minX) - CONNECTOR_MARGIN, minY: Math.min(fromBox.minY, toBox.minY) - CONNECTOR_MARGIN, maxX: Math.max(fromBox.maxX, toBox.maxX) + CONNECTOR_MARGIN, maxY: Math.max(fromBox.maxY, toBox.maxY) + CONNECTOR_MARGIN };
      const blockers = index.near(span)
        .filter((entry) => entry.id !== arrowId && entry.id !== from.id && entry.id !== to.id && entry.id !== connection.labelId)
        .map((entry) => entry.bounds);
      const route = connectionRoute(from, to, connection.route ?? "straight", blockers, lanes.get(arrowId) ?? 0); arrow.points = route;
      // Labels placed earlier in this pass are obstacles too, so two of them never stack up.
      if (connection.labelId) {
        const label = byId.get(connection.labelId);
        if (label?.type === "text") {
          // A two-letter label should claim two letters of space: a fixed block makes it collide
          // with everything and puts the visible word off the line it belongs to.
          const measured = measureTextBlock({ text: label.text, width: 260, fontSize: label.fontSize, fontFamily: label.fontFamily });
          label.width = Math.max(24, Math.min(260, Math.ceil(measured.longestLine) + 10));
          label.height = measured.height; label.textAlign = "center";
          const height = label.height;

          // The boxes this arrow connects are obstacles for the label even though the route has to
          // touch them: a word sitting on a card is the thing that makes a diagram unreadable.
          const obstacles = [...blockers, ...placedLabels.filter((placed) => boundsIntersect(placed, span)), fromBox, toBox];
          // The box to keep clear is the chip the renderer draws, not just the letters in it.
          const boxOf = (candidate: { x: number; baseline: number }): Bounds => ({ minX: candidate.x - CONNECTOR_LABEL_PADDING.x, minY: candidate.baseline - label.fontSize - CONNECTOR_LABEL_PADDING.y, maxX: candidate.x + label.width + CONNECTOR_LABEL_PADDING.x, maxY: candidate.baseline - label.fontSize + height + CONNECTOR_LABEL_PADDING.y });
          const hits = (box: Bounds): boolean => obstacles.some((other) => box.minX < other.maxX && box.maxX > other.minX && box.minY < other.maxY && box.maxY > other.minY);
          const spill = (box: Bounds): number => obstacles.reduce((total, other) => total + boundsOverlapArea(box, other), 0);

          // Every straight run of the route is a candidate, longest first, then out to the sides.
          const runs = route.slice(1).map((point, index) => ({ from: route[index], to: point, length: Math.hypot(point.x - route[index].x, point.y - route[index].y) }))
            .sort((left, right) => right.length - left.length);
          const base = label.fontSize * .9 + 8;
          const candidates: Array<{ x: number; baseline: number }> = [];
          for (const run of runs) {
            const dx = run.to.x - run.from.x; const dy = run.to.y - run.from.y; const span = run.length || 1;
            const normal = { x: -dy / span, y: dx / span };
            const preferred = normal.y > 0 ? -1 : 1;
            for (const gap of [base, base + height, base + height * 2, base + height * 3]) {
              for (const t of [.5, .32, .68, .16, .84]) {
                for (const side of [preferred, -preferred]) {
                  const point = { x: run.from.x + dx * t, y: run.from.y + dy * t };
                  candidates.push({ x: point.x + normal.x * gap * side - label.width / 2, baseline: point.y + normal.y * gap * side + label.fontSize / 2 });
                }
              }
            }
          }
          // Nothing free anywhere: take the least bad spot rather than the first one in the list.
          const clear = candidates.find((candidate) => !hits(boxOf(candidate)))
            ?? candidates.reduce((best, candidate) => spill(boxOf(candidate)) < spill(boxOf(best)) ? candidate : best, candidates[0]);
          label.x = clear.x; label.baseline = clear.baseline;
          placedLabels.push(boxOf(clear));
        }
      }
    }
  }

  private cleanGroups(): void {
    const existing = new Set(this.document.elements.map((element) => element.id));
    for (const [groupId, members] of Object.entries(this.document.groups ?? {})) { const valid = [...new Set(members.filter((id) => existing.has(id)))]; if (valid.length > 1) (this.document.groups ?? {})[groupId] = valid; else delete (this.document.groups ?? {})[groupId]; }
    this.document.artboardIds = [...new Set(this.document.artboardIds.filter((id) => existing.has(id)))];
    for (const element of this.document.elements) if (element.parentId && !existing.has(element.parentId)) delete element.parentId;
  }

  clear(): void { this.checkpoint(); this.agentBefore = null; localStorage.removeItem(PRE_AGENT_STORAGE_KEY); this.document = emptyBoard(); this.resetMutationBaseline(); this.changed("content", "reset"); }
}
