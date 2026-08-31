import { App, EventRef, TFile, normalizePath } from "obsidian";
import { PageElement, ShapeElement, StrokeElement, mergeClosedLineShapes } from "./document";
import { drawInkStroke, drawShape } from "./rendering";
import type { SmoothHandwritingSettings } from "./main";
import { optimizeShape } from "./shapes";
import { InkPoint, InkStroke, cleanCapturedStroke, strokeTouches } from "./strokes";

interface PdfInkDocument {
  version: 1;
  pdfPath: string;
  pages: Record<string, PageElement[]>;
}

type PdfTool = "off" | "pen" | "eraser" | "laser";

function safeName(path: string): string {
  let hash = 2166136261;
  for (const character of path) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  const base = path.split("/").pop()?.replace(/\.pdf$/i, "").replace(/[^\p{L}\p{N}._-]+/gu, "-") || "PDF";
  return `${base}-${(hash >>> 0).toString(16)}.smooth-pdf.json`;
}

function pointerPoint(event: PointerEvent, canvas: HTMLCanvasElement): InkPoint {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1000, (event.clientX - rect.left) * 1000 / rect.width)),
    y: Math.max(0, Math.min(1000, (event.clientY - rect.top) * 1000 / rect.height)),
    pressure: event.pressure > 0 ? event.pressure : 0.5,
    time: event.timeStamp
  };
}

export class PdfAnnotationManager {
  private refs: EventRef[] = [];
  private observer: MutationObserver | null = null;
  private attachedRoot: HTMLElement | null = null;
  private pdfFile: TFile | null = null;
  private document: PdfInkDocument | null = null;
  private tool: PdfTool = "off";
  private currentPage = "";
  private currentStroke: InkStroke | null = null;
  private currentRawPoints: InkPoint[] = [];
  private saveTimer: number | null = null;
  private readonly canvases = new Map<string, HTMLCanvasElement>();
  private readonly resizeObservers: ResizeObserver[] = [];
  private toolbar: HTMLElement | null = null;
  private reticle: HTMLElement | null = null;
  private refreshEpoch = 0;

  constructor(
    private readonly app: App,
    private readonly settings: () => SmoothHandwritingSettings,
    private readonly persistSettings: () => Promise<void>
  ) {}

  onload(): void {
    const refresh = (): void => { window.setTimeout(() => void this.refresh(), 120); };
    this.refs.push(this.app.workspace.on("file-open", refresh));
    this.refs.push(this.app.workspace.on("layout-change", refresh));
    refresh();
  }

  unload(): void {
    for (const ref of this.refs) this.app.workspace.offref(ref);
    this.refs = [];
    this.detach();
  }

  private async refresh(): Promise<void> {
    const epoch = ++this.refreshEpoch;
    const file = this.app.workspace.getActiveFile();
    const leaf = this.app.workspace.activeLeaf;
    const root = leaf?.view.containerEl;
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf" || !root) { this.detach(); return; }
    if (this.attachedRoot === root && this.pdfFile?.path === file.path) { this.attachPages(); return; }
    const loaded = await this.load(file);
    if (epoch !== this.refreshEpoch) return;
    this.detach();
    this.pdfFile = file;
    this.attachedRoot = root;
    this.document = loaded;
    this.buildToolbar(root);
    this.attachPages();
    this.observer = new MutationObserver(() => this.attachPages());
    this.observer.observe(root, { childList: true, subtree: true });
  }

  private detach(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.save();
    }
    this.observer?.disconnect();
    this.observer = null;
    this.toolbar?.remove();
    this.toolbar = null;
    this.reticle?.remove();
    this.reticle = null;
    for (const observer of this.resizeObservers) observer.disconnect();
    this.resizeObservers.length = 0;
    for (const canvas of this.canvases.values()) canvas.remove();
    this.attachedRoot?.querySelectorAll<HTMLElement>(".hp-pdf-page-host").forEach((page) => page.removeClass("hp-pdf-page-host"));
    this.attachedRoot?.removeClass("hp-pdf-root");
    this.canvases.clear();
    this.attachedRoot = null;
    this.pdfFile = null;
    this.document = null;
    this.tool = "off";
  }

  private buildToolbar(root: HTMLElement): void {
    root.addClass("hp-pdf-root");
    const toolbar = root.createDiv("hp-pdf-toolbar");
    toolbar.createSpan({ cls: "hp-pdf-title", text: "Smooth Ink" });
    const toolGroup = toolbar.createDiv("hp-tool-group");
    toolGroup.createSpan({ cls: "hp-tool-label", text: "Werkzeug" });
    for (const [tool, icon, title] of [["pen", "✎", "Auf PDF schreiben"], ["eraser", "⌫", "PDF-Tinte radieren"], ["laser", "●", "Temporärer Präsentationsstift"], ["off", "↟", "PDF-Navigation"]] as Array<[PdfTool, string, string]>) {
      const button = toolGroup.createEl("button", { text: icon, attr: { title, "aria-label": title } });
      if (tool === "off") button.addClass("is-active");
      button.addEventListener("click", () => {
        this.tool = tool;
        toolbar.querySelectorAll("button").forEach((candidate) => candidate.removeClass("is-active"));
        button.addClass("is-active");
        this.updateCanvasMode();
      });
    }
    const colorGroup = toolbar.createDiv("hp-tool-group");
    colorGroup.createSpan({ cls: "hp-tool-label", text: "Stiftfarbe" });
    for (const color of ["#202124", "#2457e6", "#d93025", "#16833b", "#7c3aed"]) {
      const swatch = colorGroup.createEl("button", { cls: "hp-color-swatch", attr: { title: color, "aria-label": `Stiftfarbe ${color}` } });
      swatch.style.setProperty("--hp-swatch", color);
      swatch.addEventListener("click", () => { this.settings().penColor = color; void this.persistSettings(); });
    }
    const customColor = colorGroup.createEl("input", { type: "color", value: this.settings().penColor, attr: { "aria-label": "Eigene PDF-Stiftfarbe" } });
    customColor.addEventListener("input", () => { this.settings().penColor = customColor.value; void this.persistSettings(); });

    const sizeGroup = toolbar.createDiv("hp-tool-group");
    sizeGroup.createSpan({ cls: "hp-tool-label", text: "Stärke" });
    const size = sizeGroup.createEl("input", { type: "range", value: String(this.settings().penSize), attr: { min: "1", max: "18", step: "0.5", "aria-label": "PDF-Stiftstärke" } });
    size.addEventListener("input", () => { this.settings().penSize = Number(size.value); void this.persistSettings(); });

    const fillGroup = toolbar.createDiv("hp-tool-group");
    fillGroup.createSpan({ cls: "hp-tool-label", text: "Formfüllung" });
    const fillColor = fillGroup.createEl("input", { type: "color", value: this.settings().fillColor, attr: { "aria-label": "PDF-Formfüllfarbe" } });
    fillColor.addEventListener("input", () => { this.settings().fillColor = fillColor.value; void this.persistSettings(); });
    const fillOpacity = fillGroup.createEl("input", { type: "range", value: String(this.settings().fillOpacity), attr: { min: "0", max: "0.8", step: "0.05", "aria-label": "PDF-Fülldeckkraft" } });
    fillOpacity.addEventListener("input", () => { this.settings().fillOpacity = Number(fillOpacity.value); void this.persistSettings(); });

    const pressureGroup = toolbar.createDiv("hp-tool-group");
    pressureGroup.createSpan({ cls: "hp-tool-label", text: "Druck" });
    const pressureToggle = pressureGroup.createEl("input", { type: "checkbox", attr: { "aria-label": "PDF-Drucksensitivität" } });
    pressureToggle.checked = this.settings().pressureEnabled;
    pressureToggle.addEventListener("change", () => { this.settings().pressureEnabled = pressureToggle.checked; void this.persistSettings(); });
    const pressure = pressureGroup.createEl("input", { type: "range", value: String(this.settings().pressureSensitivity), attr: { min: "0", max: "1", step: "0.05", "aria-label": "PDF-Druckstärke" } });
    pressure.addEventListener("input", () => { this.settings().pressureSensitivity = Number(pressure.value); void this.persistSettings(); });
    this.toolbar = toolbar;
    this.reticle = root.createDiv("hp-pen-reticle hp-pdf-reticle");
  }

  private pageElements(): HTMLElement[] {
    if (!this.attachedRoot) return [];
    const candidates = Array.from(this.attachedRoot.querySelectorAll<HTMLElement>(".pdf-viewer .page[data-page-number], .pdf-container .page[data-page-number], .pdfViewer .page[data-page-number], .page[data-page-number]"));
    return candidates.filter((page, index) => candidates.indexOf(page) === index);
  }

  private attachPages(): void {
    if (!this.document) return;
    for (const [index, pageEl] of this.pageElements().entries()) {
      const pageNumber = pageEl.dataset.pageNumber ?? String(index + 1);
      if (this.canvases.has(pageNumber) && pageEl.contains(this.canvases.get(pageNumber) ?? null)) continue;
      pageEl.addClass("hp-pdf-page-host");
      const canvas = pageEl.createEl("canvas", { cls: "hp-pdf-ink-layer", attr: { "data-smooth-page": pageNumber, "aria-label": `Smooth Handwriting PDF Seite ${pageNumber}` } });
      canvas.addEventListener("pointerdown", (event) => this.pointerDown(event, pageNumber, canvas));
      canvas.addEventListener("pointermove", (event) => this.pointerMove(event, pageNumber, canvas));
      canvas.addEventListener("pointerup", (event) => this.pointerUp(event, pageNumber, canvas));
      canvas.addEventListener("pointercancel", (event) => this.pointerUp(event, pageNumber, canvas));
      canvas.addEventListener("pointerleave", () => this.reticle?.removeClass("is-visible"));
      const resizeObserver = new ResizeObserver(() => this.draw(pageNumber));
      resizeObserver.observe(pageEl);
      this.resizeObservers.push(resizeObserver);
      this.canvases.set(pageNumber, canvas);
      this.draw(pageNumber);
    }
    this.updateCanvasMode();
  }

  private updateCanvasMode(): void {
    for (const canvas of this.canvases.values()) canvas.toggleClass("is-drawing", this.tool !== "off");
  }

  private moveReticle(event: PointerEvent): void {
    if (!this.reticle || this.tool === "off" || event.pointerType === "touch") return;
    this.reticle.style.left = `${event.clientX}px`;
    this.reticle.style.top = `${event.clientY}px`;
    this.reticle.style.setProperty("--hp-reticle-color", this.tool === "laser" ? "#ff1744" : this.settings().penColor);
    this.reticle.style.setProperty("--hp-reticle-size", `${this.tool === "eraser" ? 22 : Math.max(7, this.settings().penSize + 4)}px`);
    this.reticle.toggleClass("is-laser", this.tool === "laser");
    this.reticle.addClass("is-visible");
  }

  private pointerDown(event: PointerEvent, pageNumber: string, canvas: HTMLCanvasElement): void {
    this.moveReticle(event);
    if (this.tool === "off" || event.pointerType === "touch" || event.button !== 0 || !this.document) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    this.currentPage = pageNumber;
    const settings = this.settings();
    const point = pointerPoint(event, canvas);
    if (this.tool === "eraser") { this.erase(pageNumber, point); return; }
    this.currentStroke = { id: crypto.randomUUID(), color: this.tool === "laser" ? "#ff1744" : settings.penColor, size: settings.penSize, pressureSensitivity: settings.pressureEnabled ? settings.pressureSensitivity : 0, points: [point] };
    this.currentRawPoints = [point];
    if (this.tool === "pen") {
      const stroke: StrokeElement = { ...this.currentStroke, type: "stroke" };
      (this.document.pages[pageNumber] ??= []).push(stroke);
    }
    this.draw(pageNumber);
  }

  private pointerMove(event: PointerEvent, pageNumber: string, canvas: HTMLCanvasElement): void {
    this.moveReticle(event);
    if (this.currentPage !== pageNumber || !canvas.hasPointerCapture(event.pointerId)) return;
    event.preventDefault();
    const samples = event.getCoalescedEvents?.() ?? [event];
    if (this.tool === "eraser") { for (const sample of samples) this.erase(pageNumber, pointerPoint(sample, canvas)); return; }
    if (!this.currentStroke) return;
    for (const sample of samples) this.currentRawPoints.push(pointerPoint(sample, canvas));
    // Raw incremental feedback while the pen is down; model once on pen-up.
    this.currentStroke.points = this.currentRawPoints;
    if (this.tool === "pen" && this.document) {
      const stored = this.document.pages[pageNumber]?.find((element) => element.id === this.currentStroke?.id);
      if (stored?.type === "stroke") stored.points = this.currentStroke.points;
    }
    this.draw(pageNumber);
  }

  private pointerUp(event: PointerEvent, pageNumber: string, canvas: HTMLCanvasElement): void {
    if (!canvas.hasPointerCapture(event.pointerId)) return;
    canvas.releasePointerCapture(event.pointerId);
    if (this.tool === "pen" && this.currentStroke && this.document) {
      const elements = this.document.pages[pageNumber] ?? [];
      const index = elements.findIndex((element) => element.id === this.currentStroke?.id);
      this.currentStroke.points = cleanCapturedStroke(this.currentRawPoints, true);
      const optimized = this.settings().shapeOptimization ? optimizeShape(this.currentStroke) : { stroke: this.currentStroke, kind: null };
      if (index >= 0 && optimized.kind) {
        const shape: ShapeElement = { type: "shape", id: this.currentStroke.id, kind: optimized.kind, points: optimized.stroke.points, color: this.currentStroke.color, size: this.currentStroke.size, closed: optimized.kind !== "line" && optimized.kind !== "arrow", fillColor: this.settings().fillColor, fillOpacity: this.settings().fillOpacity };
        elements[index] = shape;
        if (optimized.kind === "line") {
          const page = { id: pageNumber, width: 1000, height: 1000, paper: "blank" as const, elements };
          mergeClosedLineShapes(page, this.settings().fillColor, this.settings().fillOpacity);
          this.document.pages[pageNumber] = page.elements;
        }
      }
      this.scheduleSave();
    }
    this.currentStroke = null;
    this.currentRawPoints = [];
    this.currentPage = "";
    this.draw(pageNumber);
  }

  private erase(pageNumber: string, point: InkPoint): void {
    if (!this.document) return;
    const elements = this.document.pages[pageNumber] ?? [];
    this.document.pages[pageNumber] = elements.filter((element) => {
      if (element.type === "stroke") return !strokeTouches(element, point, 25);
      if (element.type !== "shape") return true;
      return !element.points.some((candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y) < 25);
    });
    this.draw(pageNumber);
    this.scheduleSave();
  }

  private draw(pageNumber: string): void {
    const canvas = this.canvases.get(pageNumber);
    if (!canvas || !this.document) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(canvas.width / 1000, 0, 0, canvas.height / 1000, 0, 0);
    context.clearRect(0, 0, 1000, 1000);
    for (const element of this.document.pages[pageNumber] ?? []) {
      if (element.type === "stroke") drawInkStroke(context, element);
      else if (element.type === "shape") drawShape(context, element);
    }
    if (this.tool === "laser" && this.currentPage === pageNumber && this.currentStroke) drawInkStroke(context, this.currentStroke, true);
  }

  private sidecarPath(file: TFile): string {
    return normalizePath(`${this.settings().folder}/PDF/${safeName(file.path)}`);
  }

  private async load(file: TFile): Promise<PdfInkDocument> {
    const path = this.sidecarPath(file);
    const sidecar = this.app.vault.getAbstractFileByPath(path);
    if (sidecar instanceof TFile) {
      try {
        const parsed = JSON.parse(await this.app.vault.cachedRead(sidecar)) as PdfInkDocument;
        if (parsed.version === 1 && parsed.pdfPath === file.path && parsed.pages) return parsed;
      } catch (error) { console.error("Smooth Handwriting PDF sidecar could not be read", error); }
    }
    return { version: 1, pdfPath: file.path, pages: {} };
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { this.saveTimer = null; void this.save(); }, 350);
  }

  private async save(): Promise<void> {
    const file = this.pdfFile;
    const document = this.document;
    if (!file || !document) return;
    const settings = this.settings();
    const folder = normalizePath(`${settings.folder}/PDF`);
    const root = normalizePath(settings.folder);
    const path = normalizePath(`${settings.folder}/PDF/${safeName(file.path)}`);
    const content = JSON.stringify(document);
    if (!this.app.vault.getAbstractFileByPath(root)) await this.app.vault.createFolder(root);
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(path, content);
  }
}
