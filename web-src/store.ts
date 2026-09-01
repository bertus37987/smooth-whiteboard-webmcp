import { PageElement } from "../src/document";
import { CanvasOperation, WhiteboardDocument, boardBounds, cloneBoard, connectionPoints, emptyBoard, estimateTextHeight, migrateBoard, operationElement, scaleElement, translateElement } from "./model";

const STORAGE_KEY = "smooth-whiteboard-v2";
const LEGACY_STORAGE_KEY = "smooth-whiteboard-v1";

export class BoardStore extends EventTarget {
  document: WhiteboardDocument;
  private undoStack: WhiteboardDocument[] = [];
  private redoStack: WhiteboardDocument[] = [];
  private agentBefore: WhiteboardDocument | null = null;

  constructor() {
    super();
    try { const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY) ?? "null") as unknown; this.document = migrateBoard(parsed) ?? emptyBoard(); }
    catch { this.document = emptyBoard(); }
    this.document.connections ??= {}; this.document.groups ??= {}; this.refreshConnections(); this.cleanGroups();
  }

  checkpoint(): void { this.undoStack.push(cloneBoard(this.document)); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = []; }

  changed(): void {
    this.refreshConnections(); this.cleanGroups(); this.document.revision += 1; localStorage.setItem(STORAGE_KEY, JSON.stringify(this.document)); this.dispatchEvent(new Event("change"));
  }

  replace(document: WhiteboardDocument): void { this.document = cloneBoard(document); this.changed(); }

  undo(): boolean {
    const previous = this.undoStack.pop(); if (!previous) return false;
    this.redoStack.push(cloneBoard(this.document)); this.document = previous; this.changed(); return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop(); if (!next) return false;
    this.undoStack.push(cloneBoard(this.document)); this.document = next; this.changed(); return true;
  }

  beginAgentContribution(): void {
    if (!this.agentBefore) this.agentBefore = cloneBoard(this.document);
    if (this.document.turn) this.document.turn.status = "working";
  }

  acceptAgentContribution(): void {
    this.agentBefore = null; if (this.document.turn) { this.document.turn.status = "complete"; this.document.turn.instructionInk = []; } this.document.lastAgentRevision = this.document.revision; this.changed();
  }

  undoAgentContribution(): boolean {
    if (!this.agentBefore) return false; this.document = this.agentBefore; this.agentBefore = null; if (this.document.turn) { this.document.turn.status = "cancelled"; this.document.turn.instructionInk = []; } this.changed(); return true;
  }

  hasAgentContribution(): boolean { return this.agentBefore !== null; }

  groupIdFor(elementId: string): string | undefined { return Object.entries(this.document.groups ?? {}).find(([, members]) => members.includes(elementId))?.[0]; }

  selectionUnitCount(ids: string[]): number { return new Set(ids.map((id) => this.groupIdFor(id) ?? `element:${id}`)).size; }

  expandGroupIds(ids: string[]): string[] {
    const expanded = new Set(ids); const groups = this.document.groups ?? {};
    for (const id of ids) { const groupId = this.groupIdFor(id); if (groupId) groups[groupId]?.forEach((member) => expanded.add(member)); }
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

  applyOperation(operation: CanvasOperation, source: "human" | "agent"): string[] {
    const created: string[] = [];
    if (operation.type === "create_text" || operation.type === "create_highlight" || operation.type === "create_shape" || operation.type === "create_arrow" || operation.type === "create_stroke" || operation.type === "create_polygon") {
      const normalized = operation.type === "create_text" && source === "agent" ? { ...operation, fontFamily: operation.fontFamily ?? "handwriting", renderStyle: operation.renderStyle ?? "sketch" as const } : operation;
      const element = operationElement(normalized);
      this.document.elements.push(element); created.push(element.id);
      if (source === "agent" && !this.document.agentElementIds.includes(element.id)) this.document.agentElementIds.push(element.id);
    } else if (operation.type === "create_note") {
      const prefix = operation.id ?? `note-${crypto.randomUUID()}`; const width = Math.max(120, operation.width ?? 320); const height = Math.max(90, operation.height ?? 210);
      const shape = operationElement({ type: "create_shape", id: `${prefix}-card`, kind: "rectangle", x: operation.x, y: operation.y, width, height, color: operation.color ?? "#080808", strokeWidth: 2, fillColor: operation.fillColor ?? "#fff4b8", fillOpacity: 0.72, radius: 18 }); shape.renderStyle = operation.renderStyle ?? (source === "agent" ? "sketch" : "clean"); shape.semanticRole = "note";
      const text = operationElement({ type: "create_text", id: `${prefix}-text`, x: operation.x + 18, y: operation.y + 18, width: width - 36, text: operation.text, fontSize: 24, color: operation.color ?? "#080808", fontFamily: source === "agent" ? "handwriting" : "sans", blockStyle: operation.blockStyle ?? "body", renderStyle: operation.renderStyle, semanticRole: "note-body" });
      this.document.elements.push(shape, text); created.push(shape.id, text.id); (this.document.groups ??= {})[prefix] = [shape.id, text.id]; if (source === "agent") this.document.agentElementIds.push(shape.id, text.id);
    } else if (operation.type === "create_frame") {
      const prefix = operation.id ?? `frame-${crypto.randomUUID()}`; const shape = operationElement({ type: "create_shape", id: `${prefix}-border`, kind: "rectangle", x: operation.x, y: operation.y, width: operation.width, height: operation.height, color: operation.color ?? "#404040", strokeWidth: 2, fillColor: "#ffffff", fillOpacity: 0.04, radius: 24, lineStyle: "dashed" }); shape.renderStyle = operation.renderStyle; shape.semanticRole = "frame"; this.document.elements.push(shape); created.push(shape.id);
      if (operation.title) { const label = operationElement({ type: "create_text", id: `${prefix}-title`, x: operation.x + 18, y: operation.y + 12, width: operation.width - 36, text: operation.title, fontSize: 28, color: operation.color ?? "#080808", fontFamily: source === "agent" ? "handwriting" : "sans", fontWeight: 700, blockStyle: "heading-2", semanticRole: "frame-title" }); this.document.elements.push(label); created.push(label.id); }
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
      const element = this.document.elements.find((candidate) => candidate.id === operation.id); if (element?.type === "text") { element.text = operation.text; element.height = estimateTextHeight(element.text, element.width, element.fontSize); }
    } else if (operation.type === "update_points") {
      const element = this.document.elements.find((candidate) => candidate.id === operation.id); if (element?.type === "stroke" || element?.type === "shape" || element?.type === "highlight") element.points = operation.points.map((point) => ({ ...point, pressure: point.pressure ?? 0.5 }));
    } else if (operation.type === "update_style") {
      const expanded = this.expandGroupIds(operation.ids); for (const element of this.elementsFor(expanded)) {
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
          element.height = estimateTextHeight(element.text, element.width, element.fontSize);
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
        const points = connectionPoints(from, to); const arrow = operationElement({ type: "create_arrow", id: operation.id, from: points.from, to: points.to, color: operation.color, strokeWidth: operation.strokeWidth });
        this.document.elements.push(arrow); created.push(arrow.id); if (source === "agent") this.document.agentElementIds.push(arrow.id);
        const connection = { fromId: from.id, toId: to.id, labelId: undefined as string | undefined };
        if (operation.label) {
          const fontSize = 16; const width = Math.max(96, Math.min(260, operation.label.length * 8.5 + 20));
          const label = operationElement({ type: "create_text", x: (points.from.x + points.to.x) / 2 - width / 2, y: (points.from.y + points.to.y) / 2 - fontSize / 2, width, fontSize, text: operation.label, fontFamily: source === "agent" ? "handwriting" : "sans" });
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
    } else {
      const expanded = this.expandGroupIds(operation.ids); this.document.elements = this.document.elements.filter((element) => !expanded.includes(element.id));
      this.document.agentElementIds = this.document.agentElementIds.filter((id) => !expanded.includes(id));
    }
    return created;
  }

  private refreshConnections(): void {
    const connections = this.document.connections ??= {};
    for (const [arrowId, connection] of Object.entries(connections)) {
      const from = this.document.elements.find((element) => element.id === connection.fromId);
      const to = this.document.elements.find((element) => element.id === connection.toId);
      const arrow = this.document.elements.find((element) => element.id === arrowId);
      if (!from || !to || arrow?.type !== "shape" || arrow.kind !== "arrow") {
        const removeIds = new Set([arrowId, connection.labelId].filter((id): id is string => Boolean(id)));
        this.document.elements = this.document.elements.filter((element) => !removeIds.has(element.id));
        this.document.agentElementIds = this.document.agentElementIds.filter((id) => !removeIds.has(id));
        delete connections[arrowId]; continue;
      }
      const points = connectionPoints(from, to); arrow.points = [points.from, points.to];
      if (connection.labelId) {
        const label = this.document.elements.find((element) => element.id === connection.labelId);
        if (label?.type === "text") {
          const distance = Math.hypot(points.to.x - points.from.x, points.to.y - points.from.y);
          const offsetY = distance < label.width + 40 ? 34 : 0;
          label.x = (points.from.x + points.to.x) / 2 - label.width / 2;
          label.baseline = (points.from.y + points.to.y) / 2 + label.fontSize / 2 - offsetY;
        }
      }
    }
  }

  private cleanGroups(): void {
    const existing = new Set(this.document.elements.map((element) => element.id));
    for (const [groupId, members] of Object.entries(this.document.groups ?? {})) { const valid = [...new Set(members.filter((id) => existing.has(id)))]; if (valid.length > 1) (this.document.groups ?? {})[groupId] = valid; else delete (this.document.groups ?? {})[groupId]; }
  }

  clear(): void { this.checkpoint(); this.document = emptyBoard(); this.changed(); }
}
