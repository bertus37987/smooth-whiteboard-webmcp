import { CanvasOperation, WhiteboardDocument, cloneBoard, connectionPoints, emptyBoard, estimateTextHeight, operationElement, resizeElement, translateElement, validBoard } from "./model";

const STORAGE_KEY = "smooth-whiteboard-v1";

export class BoardStore extends EventTarget {
  document: WhiteboardDocument;
  private undoStack: WhiteboardDocument[] = [];
  private redoStack: WhiteboardDocument[] = [];
  private agentBefore: WhiteboardDocument | null = null;

  constructor() {
    super();
    try { const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown; this.document = validBoard(parsed) ? parsed : emptyBoard(); }
    catch { this.document = emptyBoard(); }
    this.document.connections ??= {}; this.refreshConnections();
  }

  checkpoint(): void { this.undoStack.push(cloneBoard(this.document)); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = []; }

  changed(): void {
    this.refreshConnections(); this.document.revision += 1; localStorage.setItem(STORAGE_KEY, JSON.stringify(this.document)); this.dispatchEvent(new Event("change"));
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
    if (this.document.request) this.document.request.state = "working";
  }

  acceptAgentContribution(): void {
    this.agentBefore = null; if (this.document.request) this.document.request.state = "answered"; this.changed();
  }

  undoAgentContribution(): boolean {
    if (!this.agentBefore) return false; this.document = this.agentBefore; this.agentBefore = null; this.changed(); return true;
  }

  hasAgentContribution(): boolean { return this.agentBefore !== null; }

  applyOperation(operation: CanvasOperation, source: "human" | "agent"): string[] {
    const created: string[] = [];
    if (operation.type === "create_text" || operation.type === "create_shape" || operation.type === "create_arrow" || operation.type === "create_stroke") {
      const element = operationElement(operation);
      this.document.elements.push(element); created.push(element.id);
      if (source === "agent" && !this.document.agentElementIds.includes(element.id)) this.document.agentElementIds.push(element.id);
    } else if (operation.type === "translate") {
      this.document.elements.filter((element) => operation.ids.includes(element.id)).forEach((element) => translateElement(element, operation.dx, operation.dy));
    } else if (operation.type === "resize") {
      const element = this.document.elements.find((candidate) => candidate.id === operation.id); if (element) resizeElement(element, operation.x, operation.y, operation.width, operation.height);
    } else if (operation.type === "update_text") {
      const element = this.document.elements.find((candidate) => candidate.id === operation.id); if (element?.type === "text") { element.text = operation.text; element.height = estimateTextHeight(element.text, element.width, element.fontSize); }
    } else if (operation.type === "update_style") {
      for (const element of this.document.elements.filter((candidate) => operation.ids.includes(candidate.id))) {
        if (operation.color && "color" in element) element.color = operation.color;
        if (element.type === "stroke" || element.type === "shape") {
          if (operation.strokeWidth !== undefined) element.size = Math.max(0.5, Math.min(32, operation.strokeWidth));
          if (element.type === "shape") { if (operation.fillColor) element.fillColor = operation.fillColor; if (operation.fillOpacity !== undefined) element.fillOpacity = Math.max(0, Math.min(1, operation.fillOpacity)); }
        } else if (element.type === "text" && operation.fontSize !== undefined) {
          element.fontSize = Math.max(10, Math.min(180, operation.fontSize)); element.height = estimateTextHeight(element.text, element.width, element.fontSize);
        }
      }
    } else if (operation.type === "reorder") {
      const selected = this.document.elements.filter((element) => operation.ids.includes(element.id)); const rest = this.document.elements.filter((element) => !operation.ids.includes(element.id));
      this.document.elements = operation.direction === "front" ? [...rest, ...selected] : [...selected, ...rest];
    } else if (operation.type === "connect") {
      const from = this.document.elements.find((element) => element.id === operation.fromId); const to = this.document.elements.find((element) => element.id === operation.toId);
      if (from && to) {
        const points = connectionPoints(from, to); const arrow = operationElement({ type: "create_arrow", id: operation.id, from: points.from, to: points.to });
        this.document.elements.push(arrow); created.push(arrow.id); if (source === "agent") this.document.agentElementIds.push(arrow.id);
        const connection = { fromId: from.id, toId: to.id, labelId: undefined as string | undefined };
        if (operation.label) {
          const fontSize = 16; const width = Math.max(96, Math.min(260, operation.label.length * 8.5 + 20));
          const label = operationElement({ type: "create_text", x: (points.from.x + points.to.x) / 2 - width / 2, y: (points.from.y + points.to.y) / 2 - fontSize / 2, width, fontSize, text: operation.label });
          this.document.elements.push(label); created.push(label.id); if (source === "agent") this.document.agentElementIds.push(label.id);
          connection.labelId = label.id;
        }
        (this.document.connections ??= {})[arrow.id] = connection;
      }
    } else {
      this.document.elements = this.document.elements.filter((element) => !operation.ids.includes(element.id));
      this.document.agentElementIds = this.document.agentElementIds.filter((id) => !operation.ids.includes(id));
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

  clear(): void { this.checkpoint(); this.document = emptyBoard(); this.changed(); }
}
