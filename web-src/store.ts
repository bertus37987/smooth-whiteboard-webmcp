import { CanvasOperation, WhiteboardDocument, cloneBoard, emptyBoard, operationElement, resizeElement, translateElement, validBoard } from "./model";

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
  }

  checkpoint(): void { this.undoStack.push(cloneBoard(this.document)); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = []; }

  changed(): void {
    this.document.revision += 1; localStorage.setItem(STORAGE_KEY, JSON.stringify(this.document)); this.dispatchEvent(new Event("change"));
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
      const element = this.document.elements.find((candidate) => candidate.id === operation.id); if (element?.type === "text") element.text = operation.text;
    } else {
      this.document.elements = this.document.elements.filter((element) => !operation.ids.includes(element.id));
      this.document.agentElementIds = this.document.agentElementIds.filter((id) => !operation.ids.includes(id));
    }
    return created;
  }

  clear(): void { this.checkpoint(); this.document = emptyBoard(); this.changed(); }
}
