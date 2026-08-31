import { App, Editor, MarkdownPostProcessorContext, MarkdownRenderChild, Notice, Plugin, PluginSettingTab, Setting, TFile, loadPdfJs, normalizePath } from "obsidian";
import { HandwritingDocumentV3, HandwritingPage, HighlightElement, ImageElement, Paper, ShapeElement, ShapeKind, StrokeElement, alignPageBaselines, cloneDocument, createDocument, createPage, elementBounds, mergeClosedLineShapes, parseDocument } from "./document";
import { normalizeHandwritingWord } from "./handwriting-normalizer";
import { ShapeDragTool, draggedShapePoints, optimizeShape, shapeContainsPoint } from "./shapes";
import { InkPoint, InkStroke, cleanCapturedStroke, pressureWidth, strokeTouches, visibleInkColor } from "./strokes";
import { snapHighlightToWords } from "./smart-highlight";
import { PdfAnnotationManager } from "./pdf-annotation";
import { buildImagePdf, buildMultiPageImagePdf, dataUrlBytes } from "./export";

type Tool = "pen" | "highlight" | "eraser" | "laser" | "fill" | ShapeDragTool;

export interface SmoothHandwritingSettings {
  settingsVersion: number;
  folder: string;
  defaultPaper: Paper;
  shapeOptimization: boolean;
  wordDelay: number;
  markerColor: string;
  markerSize: number;
  penColor: string;
  penSize: number;
  fillColor: string;
  fillOpacity: number;
  pressureEnabled: boolean;
  pressureSensitivity: number;
}

const DEFAULT_SETTINGS: SmoothHandwritingSettings = {
  settingsVersion: 3, folder: "Handwriting", defaultPaper: "grid", shapeOptimization: true, wordDelay: 800,
  markerColor: "#ffd84d", markerSize: 34, penColor: "#202124", penSize: 4,
  fillColor: "#7c5cff", fillOpacity: 0.24, pressureEnabled: true, pressureSensitivity: 0.72
};

function isShapeTool(tool: Tool): tool is ShapeDragTool {
  return ["line", "arrow", "ellipse", "circle", "rectangle", "triangle", "diamond"].includes(tool);
}

function prepareCanvas(canvas: HTMLCanvasElement, page: HandwritingPage): CanvasRenderingContext2D | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.setTransform(canvas.width / page.width, 0, 0, canvas.height / page.height, 0, 0);
  context.clearRect(0, 0, page.width, page.height);
  return context;
}

export function drawInkStroke(context: CanvasRenderingContext2D, stroke: InkStroke, laser = false): void {
  if (stroke.points.length === 0) return;
  context.save();
  context.strokeStyle = visibleInkColor(stroke.color);
  context.fillStyle = visibleInkColor(stroke.color);
  context.lineCap = "round";
  context.lineJoin = "round";
  if (laser) { context.globalAlpha = 0.92; context.shadowColor = "#ff1744"; context.shadowBlur = 18; }
  if (stroke.points.length === 1) {
    const point = stroke.points[0];
    context.beginPath();
    context.arc(point.x, point.y, pressureWidth(stroke, point) / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }
  for (let index = 0; index < stroke.points.length - 1; index += 1) {
    const before = stroke.points[index];
    const point = stroke.points[index + 1];
    const prior = stroke.points[Math.max(0, index - 1)];
    const start = index === 0 ? before : { x: (prior.x + before.x) / 2, y: (prior.y + before.y) / 2 };
    const end = index === stroke.points.length - 2 ? point : { x: (before.x + point.x) / 2, y: (before.y + point.y) / 2 };
    context.lineWidth = (pressureWidth(stroke, before) + pressureWidth(stroke, point)) / 2;
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.quadraticCurveTo(before.x, before.y, end.x, end.y);
    context.stroke();
  }
  context.restore();
}

function drawArrowHead(context: CanvasRenderingContext2D, start: InkPoint, end: InkPoint, size: number): void {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const length = Math.max(18, size * 5);
  context.moveTo(end.x, end.y);
  context.lineTo(end.x - Math.cos(angle - Math.PI / 6) * length, end.y - Math.sin(angle - Math.PI / 6) * length);
  context.moveTo(end.x, end.y);
  context.lineTo(end.x - Math.cos(angle + Math.PI / 6) * length, end.y - Math.sin(angle + Math.PI / 6) * length);
}

export function drawShape(context: CanvasRenderingContext2D, shape: ShapeElement): void {
  if (shape.points.length === 0) return;
  context.save();
  context.strokeStyle = visibleInkColor(shape.color);
  context.lineWidth = shape.size;
  context.lineCap = shape.kind === "ellipse" || shape.kind === "line" || shape.kind === "arrow" ? "round" : "butt";
  context.lineJoin = shape.kind === "ellipse" ? "round" : "miter";
  context.beginPath();
  const first = shape.points[0];
  if (shape.kind === "ellipse") {
    const box = shape.points.reduce((result, point) => ({ minX: Math.min(result.minX, point.x), minY: Math.min(result.minY, point.y), maxX: Math.max(result.maxX, point.x), maxY: Math.max(result.maxY, point.y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    context.ellipse((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.maxX - box.minX) / 2, (box.maxY - box.minY) / 2, 0, 0, Math.PI * 2);
  } else if (shape.kind === "rectangle" && shape.points.length === 2) {
    const end = shape.points[1];
    context.rect(Math.min(first.x, end.x), Math.min(first.y, end.y), Math.abs(end.x - first.x), Math.abs(end.y - first.y));
  } else {
    context.moveTo(first.x, first.y);
    for (const point of shape.points.slice(1)) context.lineTo(point.x, point.y);
    if (shape.closed) context.closePath();
    if (shape.kind === "arrow" && shape.points.length >= 2) drawArrowHead(context, first, shape.points[shape.points.length - 1], shape.size);
  }
  if (shape.closed && shape.fillColor && (shape.fillOpacity ?? 0) > 0) {
    context.save();
    context.globalAlpha = shape.fillOpacity ?? 0;
    context.fillStyle = shape.fillColor;
    context.fill();
    context.restore();
  }
  context.stroke();
  context.restore();
}

const imageCache = new Map<string, HTMLImageElement>();

function cachedImage(element: ImageElement, onload?: () => void): HTMLImageElement {
  const existing = imageCache.get(element.dataUrl);
  if (existing) return existing;
  const image = new Image();
  imageCache.set(element.dataUrl, image);
  if (onload) image.addEventListener("load", onload, { once: true });
  image.src = element.dataUrl;
  return image;
}

function drawPaper(context: CanvasRenderingContext2D, page: HandwritingPage): void {
  context.save(); context.fillStyle = "#fff"; context.fillRect(0, 0, page.width, page.height);
  context.strokeStyle = "rgba(86,117,158,.2)"; context.lineWidth = 1;
  if (page.paper === "grid") {
    for (let x = 0; x <= page.width; x += 24) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, page.height); context.stroke(); }
    for (let y = 0; y <= page.height; y += 24) { context.beginPath(); context.moveTo(0, y); context.lineTo(page.width, y); context.stroke(); }
  } else if (page.paper === "lines") {
    for (let y = 32; y <= page.height; y += 32) { context.beginPath(); context.moveTo(0, y); context.lineTo(page.width, y); context.stroke(); }
  }
  context.restore();
}

function drawPageElements(context: CanvasRenderingContext2D, page: HandwritingPage, onImageLoad?: () => void): void {
  for (const element of page.elements.filter((candidate): candidate is ImageElement => candidate.type === "image")) {
    const image = cachedImage(element, onImageLoad);
    if (image.complete && image.naturalWidth > 0) context.drawImage(image, element.x, element.y, element.width, element.height);
  }
  for (const element of page.elements.filter((candidate) => candidate.type === "highlight")) {
    const highlight = element as HighlightElement;
    context.save(); context.globalAlpha = highlight.opacity; context.strokeStyle = highlight.color; context.lineWidth = highlight.size; context.lineCap = "round";
    context.beginPath(); context.moveTo(highlight.x1, highlight.y); context.lineTo(highlight.x2, highlight.y); context.stroke(); context.restore();
  }
  for (const element of page.elements.filter((candidate) => candidate.type !== "highlight" && candidate.type !== "image")) {
    if (element.type === "stroke") drawInkStroke(context, element);
    else if (element.type === "shape") drawShape(context, element);
    else if (element.type === "text") {
      context.fillStyle = visibleInkColor(element.color); context.font = `${element.fontSize}px "Segoe Print", cursive`;
      context.textBaseline = "alphabetic"; context.fillText(element.text, element.x, element.baseline, element.width);
    }
  }
}

export function drawPage(canvas: HTMLCanvasElement, page: HandwritingPage, transient?: InkStroke): void {
  const context = prepareCanvas(canvas, page);
  if (!context) return;
  drawPageElements(context, page, () => drawPage(canvas, page, transient));
  if (transient) drawInkStroke(context, transient, true);
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
}

function loadHtmlImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("Bild konnte nicht gelesen werden")); image.src = dataUrl; });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setPaperClass(element: HTMLElement, paper: Paper): void {
  element.removeClass("hp-paper-grid", "hp-paper-lines", "hp-paper-blank");
  element.addClass(`hp-paper-${paper}`);
}

class InlineHandwritingEditor extends MarkdownRenderChild {
  private document: HandwritingDocumentV3;
  private wrapper!: HTMLDivElement;
  private pagesEl!: HTMLDivElement;
  private pageCountEl!: HTMLSpanElement;
  private statusEl!: HTMLSpanElement;
  private editButton!: HTMLButtonElement;
  private deleteButton!: HTMLButtonElement;
  private toggleButton!: HTMLButtonElement;
  private toolbar!: HTMLDivElement;
  private paperSelect!: HTMLSelectElement;
  private reticle!: HTMLDivElement;
  private tool: Tool = "pen";
  private activePageId: string;
  private readonly canvases = new Map<string, HTMLCanvasElement>();
  private observers: ResizeObserver[] = [];
  private history: HandwritingDocumentV3[] = [];
  private currentElementId: string | null = null;
  private currentRawPoints: InkPoint[] = [];
  private pointerPageId: string | null = null;
  private transientLaser: InkStroke | null = null;
  private saveTimer: number | null = null;
  private wordTimers = new Map<string, number>();
  private dirty = false;
  private editing = false;
  private expanded = false;
  private pendingStrokes = new Map<string, Set<string>>();
  private normalizationQueue: Promise<void> = Promise.resolve();
  private normalizationEpoch = 0;
  private changeRevision = 0;
  private toolButtons = new Map<Tool, HTMLButtonElement>();
  private portalAnchor: Comment | null = null;
  private touchScroll = new Map<number, number>();
  private shapeDragStart: InkPoint | null = null;

  constructor(container: HTMLElement, private readonly plugin: SmoothHandwritingPlugin, private readonly file: TFile, document: HandwritingDocumentV3, migrated: boolean) {
    super(container);
    this.document = document;
    this.activePageId = document.pages[0].id;
    this.dirty = migrated;
  }

  onload(): void {
    this.mount();
    if (this.dirty) this.scheduleSave();
    const keyHandler = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && this.editing) this.setEditing(false);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && this.editing) { event.preventDefault(); this.undo(); }
    };
    document.addEventListener("keydown", keyHandler);
    this.register(() => document.removeEventListener("keydown", keyHandler));
  }

  openEditor(): void {
    if (!this.editing) this.setEditing(true);
  }

  onunload(): void {
    this.restoreFromPortal();
    this.disconnectObservers();
    document.body.removeClass("hp-editor-open");
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    for (const timer of this.wordTimers.values()) window.clearTimeout(timer);
    if (this.dirty) void this.saveNow();
  }

  private mount(): void {
    this.containerEl.empty();
    this.wrapper = this.containerEl.createDiv("hp-inline");
    const header = this.wrapper.createDiv("hp-inline-header");
    header.createSpan({ cls: "hp-inline-title", text: "Smooth Handwriting" });
    this.pageCountEl = header.createSpan("hp-page-count");
    this.statusEl = header.createSpan("hp-status");
    this.deleteButton = header.createEl("button", { cls: "hp-delete-button", text: "Alles löschen", attr: { "aria-label": "Gesamte Handschriftnotiz leeren", title: "Alle Seiten leeren (mit Rückgängig wiederherstellbar)" } });
    this.deleteButton.addEventListener("click", () => this.clearAll());
    this.editButton = header.createEl("button", { cls: "mod-cta", text: "Bearbeiten" });
    this.editButton.addEventListener("click", () => this.setEditing(!this.editing));
    this.buildToolbar();
    this.pagesEl = this.wrapper.createDiv("hp-pages");
    this.toggleButton = this.wrapper.createEl("button", { cls: "hp-expand-button", text: "⌄", attr: { "aria-label": "Handschriftvorschau aufklappen", title: "Block vergrößern" } });
    this.toggleButton.addEventListener("click", () => this.setExpanded(!this.expanded));
    this.reticle = this.wrapper.createDiv("hp-pen-reticle");
    this.rebuildPages();
    this.updateHeader();
  }

  private labeledControl(label: string): HTMLDivElement {
    const group = this.toolbar.createDiv("hp-tool-group");
    group.createSpan({ cls: "hp-tool-label", text: label });
    return group;
  }

  private buildToolbar(): void {
    this.toolbar = this.wrapper.createDiv("hp-toolbar");
    const toolGroup = this.labeledControl("Werkzeug");
    const tools: Array<[Tool, string, string]> = [["pen", "✎", "Stift + automatische Formen"], ["highlight", "▰", "Intelligenter Markierer"], ["eraser", "⌫", "Radierer"], ["fill", "▣", "Geschlossene Form mit Stifttipp füllen"], ["laser", "●", "Präsentationsstift (nur beim Halten)"]];
    for (const [tool, icon, label] of tools) {
      const button = toolGroup.createEl("button", { text: icon, attr: { "aria-label": label, title: label } });
      button.addEventListener("click", () => this.activateTool(tool));
      this.toolButtons.set(tool, button);
    }
    const shapeGroup = this.labeledControl("Form ziehen");
    const shapeTools: Array<[ShapeDragTool, string, string]> = [
      ["line", "╱", "Gerade"], ["arrow", "➜", "Pfeil"], ["rectangle", "▭", "Rechteck"],
      ["ellipse", "⬭", "Oval"], ["circle", "○", "Kreis"], ["triangle", "△", "Dreieck"], ["diamond", "◇", "Raute"]
    ];
    for (const [tool, icon, label] of shapeTools) {
      const button = shapeGroup.createEl("button", { text: icon, attr: { "aria-label": label, title: `${label} ziehen` } });
      button.addEventListener("click", () => this.activateTool(tool));
      this.toolButtons.set(tool, button);
    }
    const colorGroup = this.labeledControl("Stiftfarbe");
    for (const color of ["#202124", "#2457e6", "#d93025", "#16833b", "#7c3aed"]) {
      const swatch = colorGroup.createEl("button", { cls: "hp-color-swatch", attr: { "aria-label": color, title: color } });
      swatch.style.setProperty("--hp-swatch", color);
      swatch.addEventListener("click", () => { this.plugin.settings.penColor = color; void this.plugin.persistSettings(); this.updateReticleStyle(); });
    }
    const penColor = colorGroup.createEl("input", { type: "color", value: this.plugin.settings.penColor, attr: { "aria-label": "Eigene Stiftfarbe" } });
    penColor.addEventListener("input", () => { this.plugin.settings.penColor = penColor.value; void this.plugin.persistSettings(); this.updateReticleStyle(); });
    const sizeGroup = this.labeledControl("Stärke");
    const size = sizeGroup.createEl("input", { type: "range", value: String(this.plugin.settings.penSize), attr: { min: "1", max: "18", step: "0.5" } });
    size.addEventListener("input", () => { this.plugin.settings.penSize = Number(size.value); void this.plugin.persistSettings(); this.updateReticleStyle(); });
    const fillGroup = this.labeledControl("Formfüllung");
    const fill = fillGroup.createEl("input", { type: "color", value: this.plugin.settings.fillColor, attr: { "aria-label": "Füllfarbe" } });
    fill.addEventListener("input", () => { this.plugin.settings.fillColor = fill.value; void this.plugin.persistSettings(); });
    const fillToggle = fillGroup.createEl("input", { type: "checkbox", attr: { "aria-label": "Formfüllung aktivieren", title: "Formfüllung an/aus" } });
    fillToggle.checked = this.plugin.settings.fillOpacity > 0;
    fillToggle.addEventListener("change", () => {
      this.plugin.settings.fillOpacity = fillToggle.checked ? Math.max(0.24, Number(fillOpacity.value)) : 0;
      fillOpacity.value = String(this.plugin.settings.fillOpacity); void this.plugin.persistSettings();
    });
    const fillOpacity = fillGroup.createEl("input", { type: "range", value: String(this.plugin.settings.fillOpacity), attr: { min: "0", max: "0.8", step: "0.05", "aria-label": "Deckkraft der Füllung" } });
    fillOpacity.addEventListener("input", () => { this.plugin.settings.fillOpacity = Number(fillOpacity.value); fillToggle.checked = this.plugin.settings.fillOpacity > 0; void this.plugin.persistSettings(); });
    const pressureGroup = this.labeledControl("Druck");
    const pressureToggle = pressureGroup.createEl("input", { type: "checkbox", attr: { "aria-label": "Drucksensitivität" } });
    pressureToggle.checked = this.plugin.settings.pressureEnabled;
    pressureToggle.addEventListener("change", () => { this.plugin.settings.pressureEnabled = pressureToggle.checked; void this.plugin.persistSettings(); });
    const pressure = pressureGroup.createEl("input", { type: "range", value: String(this.plugin.settings.pressureSensitivity), attr: { min: "0", max: "1", step: "0.05", "aria-label": "Stärke der Drucksensitivität" } });
    pressure.addEventListener("input", () => { this.plugin.settings.pressureSensitivity = Number(pressure.value); void this.plugin.persistSettings(); });
    const pageGroup = this.labeledControl("Seite");
    this.paperSelect = pageGroup.createEl("select", { attr: { "aria-label": "Papierart" } });
    this.paperSelect.createEl("option", { value: "grid", text: "Kariert" });
    this.paperSelect.createEl("option", { value: "lines", text: "Liniert" });
    this.paperSelect.createEl("option", { value: "blank", text: "Blanko" });
    this.paperSelect.addEventListener("change", () => this.changePaper(this.paperSelect.value as Paper));
    pageGroup.createEl("button", { text: "+", attr: { "aria-label": "Seite hinzufügen", title: "Seite hinzufügen" } }).addEventListener("click", () => this.addPage());
    pageGroup.createEl("button", { text: "↶", attr: { "aria-label": "Rückgängig", title: "Rückgängig" } }).addEventListener("click", () => this.undo());
    const fileGroup = this.labeledControl("Datei");
    for (const [format, label] of [["png", "PNG"], ["jpeg", "JPG"], ["pdf", "PDF"]] as const) {
      fileGroup.createEl("button", { text: label, attr: { "aria-label": `Aktive Seite als ${label} speichern`, title: `Aktive Seite als ${label} herunterladen` } })
        .addEventListener("click", () => void this.exportActivePage(format));
    }
    fileGroup.createEl("button", { text: "PDF alle", attr: { "aria-label": "Alle Seiten als mehrseitige PDF speichern", title: "Gesamte Handschriftnotiz als mehrseitige PDF herunterladen" } })
      .addEventListener("click", () => void this.exportAllPagesPdf());
    const importInput = fileGroup.createEl("input", { type: "file", attr: { accept: "image/png,image/jpeg,application/pdf", multiple: "", "aria-label": "PNG, JPEG oder PDF importieren" } });
    importInput.addClass("hp-file-input");
    fileGroup.createEl("button", { text: "↧", attr: { "aria-label": "PNG, JPEG oder PDF importieren", title: "Datei als beschreibbaren Hintergrund importieren" } })
      .addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", () => { const files = Array.from(importInput.files ?? []); importInput.value = ""; if (files.length > 0) void this.importFiles(files); });
    this.paperSelect.value = this.activePage()?.paper ?? this.plugin.settings.defaultPaper;
    this.activateTool("pen");
  }

  private setEditing(value: boolean): void {
    this.editing = value;
    if (value) this.moveToPortal();
    else this.restoreFromPortal();
    this.wrapper.toggleClass("is-editing", value);
    document.body.toggleClass("hp-editor-open", value);
    this.editButton.setText(value ? "Fertig" : "Bearbeiten");
    this.reticle.removeClass("is-visible");
    if (!value) {
      this.setExpanded(false);
      if (this.dirty) void this.saveNow();
    }
    requestAnimationFrame(() => this.redrawAll());
  }

  private setExpanded(value: boolean): void {
    this.expanded = value;
    this.wrapper.toggleClass("is-expanded", value);
    this.toggleButton.setText(value ? "⌃" : "⌄");
    this.toggleButton.setAttribute("aria-label", value ? "Handschriftvorschau zuklappen" : "Handschriftvorschau aufklappen");
    requestAnimationFrame(() => this.redrawAll());
  }

  private moveToPortal(): void {
    if (this.portalAnchor || this.wrapper.parentNode === document.body) return;
    const parent = this.wrapper.parentNode;
    if (!parent) return;
    this.portalAnchor = document.createComment("Smooth Handwriting fullscreen portal");
    parent.insertBefore(this.portalAnchor, this.wrapper);
    document.body.appendChild(this.wrapper);
  }

  private restoreFromPortal(): void {
    if (!this.portalAnchor) return;
    const parent = this.portalAnchor.parentNode;
    if (parent) {
      parent.insertBefore(this.wrapper, this.portalAnchor);
      this.portalAnchor.remove();
    } else this.wrapper.remove();
    this.portalAnchor = null;
  }

  private activateTool(tool: Tool): void {
    this.tool = tool;
    this.wrapper.dataset.tool = tool;
    for (const [candidate, button] of this.toolButtons) button.toggleClass("is-active", candidate === tool);
    this.updateReticleStyle();
  }

  private updateReticleStyle(): void {
    if (!this.reticle) return;
    const color = this.tool === "laser" ? "#ff1744" : this.tool === "highlight" ? this.plugin.settings.markerColor : this.tool === "fill" ? this.plugin.settings.fillColor : this.plugin.settings.penColor;
    const size = this.tool === "eraser" ? 22 : this.tool === "highlight" ? Math.min(24, this.plugin.settings.markerSize / 2) : Math.max(7, this.plugin.settings.penSize + 4);
    this.reticle.style.setProperty("--hp-reticle-color", color);
    this.reticle.style.setProperty("--hp-reticle-size", `${size}px`);
    this.reticle.toggleClass("is-laser", this.tool === "laser");
  }

  private updateReticle(event: PointerEvent): void {
    if (!this.editing || event.pointerType === "touch") return;
    this.reticle.style.left = `${event.clientX}px`;
    this.reticle.style.top = `${event.clientY}px`;
    this.reticle.addClass("is-visible");
  }

  private rebuildPages(): void {
    this.disconnectObservers();
    this.canvases.clear();
    this.pagesEl.empty();
    for (const [index, page] of this.document.pages.entries()) {
      const frame = this.pagesEl.createDiv("hp-page");
      frame.dataset.pageId = page.id;
      frame.toggleClass("is-active", page.id === this.activePageId);
      setPaperClass(frame, page.paper);
      frame.createDiv({ cls: "hp-page-label", text: `Seite ${index + 1}` });
      const canvas = frame.createEl("canvas", { attr: { "aria-label": `Handschrift Seite ${index + 1}` } });
      canvas.style.aspectRatio = `${page.width} / ${page.height}`;
      canvas.addEventListener("pointerenter", (event) => this.updateReticle(event));
      canvas.addEventListener("pointerleave", () => this.reticle.removeClass("is-visible"));
      canvas.addEventListener("pointerdown", (event) => this.pointerDown(event, page.id));
      canvas.addEventListener("pointermove", (event) => this.pointerMove(event, page.id));
      canvas.addEventListener("pointerup", (event) => this.pointerUp(event, page.id));
      canvas.addEventListener("pointercancel", (event) => this.pointerUp(event, page.id));
      frame.addEventListener("click", () => this.setActivePage(page.id));
      const observer = new ResizeObserver(() => { this.updatePaperScale(frame, canvas, page); this.redrawPage(page.id); });
      observer.observe(canvas);
      this.observers.push(observer);
      this.canvases.set(page.id, canvas);
    }
    this.updateHeader();
    requestAnimationFrame(() => this.redrawAll());
  }

  private updatePaperScale(frame: HTMLElement, canvas: HTMLCanvasElement, page: HandwritingPage): void {
    const scaleX = canvas.clientWidth / page.width;
    const scaleY = canvas.clientHeight / page.height;
    frame.style.setProperty("--hp-grid-x", `${24 * scaleX}px`);
    frame.style.setProperty("--hp-grid-y", `${24 * scaleY}px`);
    frame.style.setProperty("--hp-line-y", `${32 * scaleY}px`);
  }

  private disconnectObservers(): void { for (const observer of this.observers) observer.disconnect(); this.observers = []; }
  private updateHeader(): void { this.pageCountEl?.setText(`${this.document.pages.length} ${this.document.pages.length === 1 ? "Seite" : "Seiten"}`); }
  private setActivePage(pageId: string): void {
    this.activePageId = pageId;
    const active = this.activePage();
    if (active && this.paperSelect) this.paperSelect.value = active.paper;
    this.pagesEl.querySelectorAll<HTMLElement>(".hp-page").forEach((frame) => frame.toggleClass("is-active", frame.dataset.pageId === pageId));
  }
  private activePage(): HandwritingPage | undefined { return this.document.pages.find((page) => page.id === this.activePageId); }
  private page(pageId: string): HandwritingPage | undefined { return this.document.pages.find((page) => page.id === pageId); }

  private toPoint(event: PointerEvent, page: HandwritingPage, canvas: HTMLCanvasElement): InkPoint {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(page.width, (event.clientX - rect.left) * page.width / rect.width)), y: Math.max(0, Math.min(page.height, (event.clientY - rect.top) * page.height / rect.height)), pressure: event.pressure > 0 ? event.pressure : 0.5, time: event.timeStamp };
  }

  private pointerDown(event: PointerEvent, pageId: string): void {
    this.updateReticle(event);
    if (!this.editing) return;
    const page = this.page(pageId); const canvas = this.canvases.get(pageId);
    if (!page || !canvas) return;
    if (event.pointerType === "touch") {
      if (this.pointerPageId === null) { this.touchScroll.set(event.pointerId, event.clientY); canvas.setPointerCapture(event.pointerId); }
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault(); this.setActivePage(pageId); canvas.setPointerCapture(event.pointerId); this.pointerPageId = pageId;
    const point = this.toPoint(event, page, canvas);
    if (this.tool === "laser") {
      this.transientLaser = { id: "laser", color: "#ff1744", size: Math.max(5, this.plugin.settings.penSize * 1.35), pressureSensitivity: 0, points: [point] };
      this.redrawPage(pageId); return;
    }
    this.remember();
    if (this.tool === "eraser") { this.eraseAt(page, point); return; }
    if (this.tool === "fill") {
      const target = [...page.elements].reverse().find((element): element is ShapeElement => element.type === "shape" && shapeContainsPoint(element, point));
      if (target) {
        target.fillColor = this.plugin.settings.fillColor;
        target.fillOpacity = Math.max(0.24, this.plugin.settings.fillOpacity);
        this.markChanged(); this.redrawPage(pageId);
      } else this.history.pop();
      canvas.releasePointerCapture(event.pointerId); this.pointerPageId = null; return;
    }
    if (this.tool === "highlight") {
      const element: HighlightElement = { type: "highlight", id: crypto.randomUUID(), x1: point.x, x2: point.x, y: point.y, size: this.plugin.settings.markerSize, color: this.plugin.settings.markerColor, opacity: 0.28 };
      page.elements.push(element); this.currentElementId = element.id; this.currentRawPoints = [point];
    } else if (isShapeTool(this.tool)) {
      const kind: ShapeKind = this.tool === "circle" ? "ellipse" : this.tool === "triangle" || this.tool === "diamond" ? "polygon" : this.tool;
      const element: ShapeElement = { type: "shape", id: crypto.randomUUID(), kind, points: draggedShapePoints(this.tool, point, point), color: this.plugin.settings.penColor, size: this.plugin.settings.penSize, closed: this.tool !== "line" && this.tool !== "arrow", fillColor: this.plugin.settings.fillColor, fillOpacity: this.tool === "line" || this.tool === "arrow" ? 0 : this.plugin.settings.fillOpacity };
      page.elements.push(element); this.currentElementId = element.id; this.shapeDragStart = point;
    } else {
      const element: StrokeElement = { type: "stroke", id: crypto.randomUUID(), color: this.plugin.settings.penColor, size: this.plugin.settings.penSize, pressureSensitivity: this.plugin.settings.pressureEnabled ? this.plugin.settings.pressureSensitivity : 0, points: [point] };
      page.elements.push(element); this.currentElementId = element.id; this.currentRawPoints = [point];
    }
    this.redrawPage(pageId);
  }

  private pointerMove(event: PointerEvent, pageId: string): void {
    this.updateReticle(event);
    const touchY = this.touchScroll.get(event.pointerId);
    if (touchY !== undefined) {
      event.preventDefault();
      this.pagesEl.scrollTop += touchY - event.clientY;
      this.touchScroll.set(event.pointerId, event.clientY);
      return;
    }
    if (!this.editing || this.pointerPageId !== pageId) return;
    const page = this.page(pageId); const canvas = this.canvases.get(pageId);
    if (!page || !canvas || !canvas.hasPointerCapture(event.pointerId)) return;
    event.preventDefault(); const events = event.getCoalescedEvents?.() ?? [event];
    if (this.tool === "laser" && this.transientLaser) {
      for (const sample of events) this.transientLaser.points.push(this.toPoint(sample, page, canvas));
      this.redrawPage(pageId); return;
    }
    if (this.tool === "eraser") { for (const sample of events) this.eraseAt(page, this.toPoint(sample, page, canvas)); return; }
    const element = page.elements.find((candidate) => candidate.id === this.currentElementId);
    if (!element) return;
    if (element.type === "highlight") {
      for (const sample of events) this.currentRawPoints.push(this.toPoint(sample, page, canvas));
      element.x2 = this.currentRawPoints[this.currentRawPoints.length - 1].x;
      const ys = this.currentRawPoints.map((point) => point.y).sort((left, right) => left - right);
      element.y = ys[Math.floor(ys.length / 2)];
    }
    else if (element.type === "stroke") {
      // Keep the pen-down path entirely incremental. Re-running the model over
      // the full stroke on every pointer event caused the Lenovo pen lag.
      for (const sample of events) this.currentRawPoints.push(this.toPoint(sample, page, canvas));
      element.points = this.currentRawPoints;
    }
    else if (element.type === "shape" && isShapeTool(this.tool) && this.shapeDragStart) element.points = draggedShapePoints(this.tool, this.shapeDragStart, this.toPoint(events[events.length - 1], page, canvas));
    this.redrawPage(pageId);
  }

  private pointerUp(event: PointerEvent, pageId: string): void {
    const page = this.page(pageId); const canvas = this.canvases.get(pageId);
    if (!page || !canvas) return;
    if (this.touchScroll.has(event.pointerId)) {
      this.touchScroll.delete(event.pointerId);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      return;
    }
    if (!canvas.hasPointerCapture(event.pointerId)) return;
    event.preventDefault(); canvas.releasePointerCapture(event.pointerId);
    if (this.tool === "laser") { this.transientLaser = null; this.pointerPageId = null; this.redrawPage(pageId); return; }
    const element = page.elements.find((candidate) => candidate.id === this.currentElementId);
    if (element?.type === "stroke") { element.points = cleanCapturedStroke(this.currentRawPoints, true); if (!this.convertAutomaticShape(page, element)) this.queueWordStroke(pageId, element.id); }
    else if (element?.type === "highlight") {
      const snapped = snapHighlightToWords(page, element, this.currentRawPoints);
      if (snapped) Object.assign(element, snapped);
      else page.elements = page.elements.filter((candidate) => candidate.id !== element.id);
    }
    else if (element?.type === "shape") {
      const box = elementBounds(element);
      if (Math.max(box.maxX - box.minX, box.maxY - box.minY) < 8) page.elements = page.elements.filter((candidate) => candidate.id !== element.id);
    }
    this.currentElementId = null; this.currentRawPoints = []; this.shapeDragStart = null; this.pointerPageId = null; this.markChanged(); this.redrawPage(pageId);
  }

  private convertAutomaticShape(page: HandwritingPage, stroke: StrokeElement): boolean {
    if (!this.plugin.settings.shapeOptimization) return false;
    const optimized = optimizeShape(stroke);
    if (!optimized.kind) return false;
    const index = page.elements.findIndex((element) => element.id === stroke.id);
    if (index < 0) return false;
    const kind: ShapeKind = optimized.kind;
    page.elements[index] = { type: "shape", id: stroke.id, kind, points: optimized.stroke.points, color: stroke.color, size: stroke.size, closed: kind !== "line" && kind !== "arrow", fillColor: this.plugin.settings.fillColor, fillOpacity: kind === "line" || kind === "arrow" ? 0 : this.plugin.settings.fillOpacity };
    if (kind === "line") mergeClosedLineShapes(page, this.plugin.settings.fillColor, this.plugin.settings.fillOpacity);
    this.setStatus(`Form erkannt: ${kind === "ellipse" ? "Ellipse" : kind === "rectangle" ? "Rechteck" : kind === "polygon" ? "Vieleck" : "Gerade"}`);
    window.setTimeout(() => this.setStatus(""), 1400); return true;
  }

  private eraseAt(page: HandwritingPage, point: InkPoint): void {
    const before = page.elements.length;
    page.elements = page.elements.filter((element) => {
      if (element.type === "stroke") return !strokeTouches(element, point, 18);
      if (element.type === "image") return true;
      const box = elementBounds(element);
      return point.x < box.minX - 18 || point.x > box.maxX + 18 || point.y < box.minY - 18 || point.y > box.maxY + 18;
    });
    if (page.elements.length !== before) { this.markChanged(); this.redrawPage(page.id); }
  }

  private queueWordStroke(pageId: string, strokeId: string): void {
    const pending = this.pendingStrokes.get(pageId) ?? new Set<string>(); pending.add(strokeId); this.pendingStrokes.set(pageId, pending);
    const oldTimer = this.wordTimers.get(pageId); if (oldTimer !== undefined) window.clearTimeout(oldTimer);
    const timer = window.setTimeout(() => { this.wordTimers.delete(pageId); const ids = [...(this.pendingStrokes.get(pageId) ?? [])]; this.pendingStrokes.delete(pageId); if (ids.length > 0) this.enqueueNormalization(pageId, ids); }, this.plugin.settings.wordDelay);
    this.wordTimers.set(pageId, timer);
  }

  private enqueueNormalization(pageId: string, ids: string[]): void {
    const epoch = this.normalizationEpoch;
    this.normalizationQueue = this.normalizationQueue.then(() => this.normalizeWord(pageId, ids, epoch)).catch((error) => { console.error("Smooth Handwriting normalization failed", error); this.setStatus("Korrektur übersprungen"); });
  }

  private async normalizeWord(pageId: string, ids: string[], epoch: number): Promise<void> {
    await Promise.resolve();
    const page = this.page(pageId); if (!page || epoch !== this.normalizationEpoch) return;
    const original = ids.map((id) => page.elements.find((element): element is StrokeElement => element.id === id && element.type === "stroke")).filter((stroke): stroke is StrokeElement => Boolean(stroke));
    if (original.length === 0) return;
    const signature = JSON.stringify(original); this.setStatus("Richte Handschrift aus …");
    const result = normalizeHandwritingWord(original, this.document.profile, page.paper, page.baselines ?? []);
    const current = ids.map((id) => page.elements.find((element): element is StrokeElement => element.id === id && element.type === "stroke")).filter((stroke): stroke is StrokeElement => Boolean(stroke));
    if (epoch !== this.normalizationEpoch || JSON.stringify(current) !== signature) { this.setStatus("Neuere Eingabe behalten"); return; }
    if (result.changed) {
      this.remember(); this.document.profile = result.profile; const replacements = new Map(result.strokes.map((stroke) => [stroke.id, stroke]));
      page.elements = page.elements.map((element) => replacements.get(element.id) ?? element);
      this.registerBaseline(page, result.baseline);
      this.markChanged(); this.redrawPage(pageId); this.setStatus("Persönliche Schrift ausgerichtet");
    } else { this.document.profile = result.profile; this.registerBaseline(page, result.baseline); this.markChanged(); this.setStatus(""); }
    window.setTimeout(() => this.setStatus(""), 1600);
  }

  private setStatus(text: string): void { this.statusEl.setText(text); }
  private registerBaseline(page: HandwritingPage, baseline: number): void {
    if (!Number.isFinite(baseline) || baseline <= 0 || baseline >= page.height) return;
    const baselines = page.baselines ?? [];
    if (!baselines.some((candidate) => Math.abs(candidate - baseline) < 12)) baselines.push(baseline);
    page.baselines = baselines.sort((left, right) => left - right);
  }
  private changePaper(paper: Paper): void {
    const page = this.activePage(); if (!page) return; this.remember(); page.paper = paper; alignPageBaselines(page);
    const frame = this.pagesEl.querySelector<HTMLElement>(`[data-page-id="${page.id}"]`); if (frame) setPaperClass(frame, paper); this.markChanged();
  }
  private addPage(): void {
    this.remember(); const page = createPage(this.activePage()?.paper ?? this.plugin.settings.defaultPaper); this.document.pages.push(page); this.activePageId = page.id; this.rebuildPages(); this.markChanged();
    requestAnimationFrame(() => this.pagesEl.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }
  private async renderExportCanvas(page: HandwritingPage): Promise<HTMLCanvasElement> {
    const images = page.elements.filter((element): element is ImageElement => element.type === "image");
    await Promise.all(images.map(async (element) => {
      const image = cachedImage(element);
      if (!image.complete || image.naturalWidth === 0) await new Promise<void>((resolve, reject) => { image.addEventListener("load", () => resolve(), { once: true }); image.addEventListener("error", () => reject(new Error("Importbild konnte nicht exportiert werden")), { once: true }); });
    }));
    const canvas = document.createElement("canvas"); canvas.width = page.width; canvas.height = page.height;
    const context = canvas.getContext("2d"); if (!context) throw new Error("Canvas nicht verfügbar");
    drawPaper(context, page); drawPageElements(context, page); return canvas;
  }
  private async exportActivePage(format: "png" | "jpeg" | "pdf"): Promise<void> {
    const page = this.activePage(); if (!page) return;
    try {
      this.setStatus(`Exportiere ${format.toUpperCase()} …`);
      const canvas = await this.renderExportCanvas(page);
      const pageNumber = this.document.pages.findIndex((candidate) => candidate.id === page.id) + 1;
      const basename = `Smooth-Handwriting-Seite-${pageNumber}`;
      if (format === "pdf") {
        const jpegUrl = canvas.toDataURL("image/jpeg", 0.94);
        const pdf = buildImagePdf(dataUrlBytes(jpegUrl), canvas.width, canvas.height);
        downloadBlob(new Blob([pdf as BlobPart], { type: "application/pdf" }), `${basename}.pdf`);
      } else {
        const mime = format === "png" ? "image/png" : "image/jpeg";
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Export fehlgeschlagen")), mime, 0.94));
        downloadBlob(blob, `${basename}.${format === "png" ? "png" : "jpg"}`);
      }
      this.setStatus(`${format.toUpperCase()} heruntergeladen`); window.setTimeout(() => this.setStatus(""), 1600);
    } catch (error) { new Notice(`Export fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`); this.setStatus(""); }
  }
  private async exportAllPagesPdf(): Promise<void> {
    try {
      this.setStatus("Exportiere mehrseitige PDF …");
      const pages = [];
      for (const page of this.document.pages) {
        const canvas = await this.renderExportCanvas(page);
        pages.push({ jpeg: dataUrlBytes(canvas.toDataURL("image/jpeg", 0.94)), pixelWidth: canvas.width, pixelHeight: canvas.height });
      }
      const pdf = buildMultiPageImagePdf(pages);
      downloadBlob(new Blob([pdf as BlobPart], { type: "application/pdf" }), "Smooth-Handwriting-Gesamtnotiz.pdf");
      this.setStatus(`${pages.length} Seiten als PDF heruntergeladen`);
      window.setTimeout(() => this.setStatus(""), 1800);
    } catch (error) { new Notice(`PDF-Export fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`); this.setStatus(""); }
  }
  private placeImage(page: HandwritingPage, dataUrl: string, mimeType: "image/png" | "image/jpeg", sourceName: string, sourceWidth: number, sourceHeight: number): void {
    const scale = Math.min(page.width / sourceWidth, page.height / sourceHeight);
    const width = sourceWidth * scale; const height = sourceHeight * scale;
    const element: ImageElement = { type: "image", id: crypto.randomUUID(), x: (page.width - width) / 2, y: (page.height - height) / 2, width, height, dataUrl, mimeType, sourceName };
    page.elements.unshift(element);
  }
  private async importFiles(files: File[]): Promise<void> {
    this.remember(); let imageTargetUsed = false; let importedPages = 0;
    try {
      this.setStatus("Importiere Datei …");
      for (const file of files) {
        if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
          const pdfjs = await loadPdfJs();
          const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
          for (let number = 1; number <= pdf.numPages; number += 1) {
            const sourcePage = await pdf.getPage(number); const viewport = sourcePage.getViewport({ scale: 1.5 });
            const canvas = document.createElement("canvas"); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext("2d"); if (!context) throw new Error("PDF-Canvas nicht verfügbar");
            await sourcePage.render({ canvasContext: context, viewport }).promise;
            const page = createPage("blank"); this.placeImage(page, canvas.toDataURL("image/jpeg", 0.92), "image/jpeg", `${file.name} – Seite ${number}`, canvas.width, canvas.height);
            this.document.pages.push(page); this.activePageId = page.id; importedPages += 1;
          }
          await pdf.destroy();
        } else if (file.type === "image/png" || file.type === "image/jpeg" || /\.(png|jpe?g)$/i.test(file.name)) {
          const dataUrl = await readDataUrl(file); const image = await loadHtmlImage(dataUrl);
          const useCurrentPage = !imageTargetUsed && importedPages === 0;
          const page = useCurrentPage ? this.activePage() ?? createPage("blank") : createPage("blank");
          if (!this.document.pages.includes(page)) this.document.pages.push(page);
          if (!useCurrentPage) this.activePageId = page.id;
          this.placeImage(page, dataUrl, file.type === "image/png" ? "image/png" : "image/jpeg", file.name, image.naturalWidth, image.naturalHeight);
          imageTargetUsed = true; importedPages += 1;
        } else throw new Error(`Nicht unterstütztes Format: ${file.name}`);
      }
      this.rebuildPages(); this.markChanged(); this.setStatus(`${importedPages} Seite${importedPages === 1 ? "" : "n"} importiert`); window.setTimeout(() => this.setStatus(""), 1800);
    } catch (error) {
      const previous = this.history.pop(); if (previous) this.document = previous;
      this.activePageId = this.document.pages[0].id; this.rebuildPages();
      new Notice(`Import fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`); this.setStatus("");
    }
  }
  private clearAll(): void {
    if (!window.confirm("Wirklich alle Seiten dieser Handschriftnotiz leeren? Rückgängig stellt sie wieder her.")) return;
    const paper = this.activePage()?.paper ?? this.plugin.settings.defaultPaper;
    this.remember();
    const page = createPage(paper);
    this.document = { version: 3, pages: [page], profile: { targetHeight: 52, samples: 0, averageSlope: 0 } };
    this.activePageId = page.id;
    this.pendingStrokes.clear();
    for (const timer of this.wordTimers.values()) window.clearTimeout(timer);
    this.wordTimers.clear(); this.normalizationEpoch += 1;
    this.rebuildPages(); this.markChanged(); this.setStatus("Notiz geleert – Rückgängig ist möglich");
  }
  private remember(): void { this.history.push(cloneDocument(this.document)); if (this.history.length > 60) this.history.shift(); }
  private undo(): void {
    const previous = this.history.pop(); if (!previous) return; this.document = previous;
    if (!this.document.pages.some((page) => page.id === this.activePageId)) this.activePageId = this.document.pages[0].id;
    this.pendingStrokes.clear(); for (const timer of this.wordTimers.values()) window.clearTimeout(timer); this.wordTimers.clear(); this.normalizationEpoch += 1; this.rebuildPages(); this.markChanged();
  }
  private markChanged(): void { this.dirty = true; this.changeRevision += 1; this.scheduleSave(); }
  private scheduleSave(): void { if (this.saveTimer !== null) window.clearTimeout(this.saveTimer); this.saveTimer = window.setTimeout(() => { this.saveTimer = null; void this.saveNow(); }, 500); }
  private async saveNow(): Promise<void> {
    if (!this.dirty) return; const revision = this.changeRevision;
    try { await this.plugin.saveDocument(this.file, this.document); if (revision === this.changeRevision) this.dirty = false; }
    catch (error) { new Notice(`Smooth Handwriting konnte nicht speichern: ${error instanceof Error ? error.message : String(error)}`); }
  }
  private redrawPage(pageId: string): void { const page = this.page(pageId); const canvas = this.canvases.get(pageId); if (page && canvas) drawPage(canvas, page, this.pointerPageId === pageId ? this.transientLaser ?? undefined : undefined); }
  private redrawAll(): void { for (const page of this.document.pages) this.redrawPage(page.id); }
}

export default class SmoothHandwritingPlugin extends Plugin {
  settings: SmoothHandwritingSettings = DEFAULT_SETTINGS;
  private pdfManager!: PdfAnnotationManager;
  private pendingOpenPath: string | null = null;
  async onload(): Promise<void> {
    const stored = await this.loadData() as Partial<SmoothHandwritingSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    if ((stored?.settingsVersion ?? 0) < 3) {
      this.settings.settingsVersion = 3;
      // Earlier builds wrote 500 ms, which frequently fired between letters.
      if (stored?.wordDelay === undefined || stored.wordDelay <= 500) this.settings.wordDelay = 800;
      if (stored?.fillOpacity === undefined || stored.fillOpacity === 0) this.settings.fillOpacity = 0.24;
      await this.persistSettings();
    }
    this.addSettingTab(new SmoothHandwritingSettingTab(this.app, this));
    this.addCommand({ id: "insert-handwriting-block", name: "Karierten Handschriftblock einfügen", editorCallback: async (editor: Editor) => this.insertBlock(editor) });
    this.registerMarkdownCodeBlockProcessor("handschrift", async (source, element, context) => this.renderBlock(source.trim(), element, context));
    this.pdfManager = new PdfAnnotationManager(this.app, () => this.settings, () => this.persistSettings()); this.pdfManager.onload(); this.register(() => this.pdfManager.unload());
  }
  persistSettings(): Promise<void> { return this.saveData(this.settings); }
  private async insertBlock(editor: Editor): Promise<void> {
    const folder = normalizePath(this.settings.folder.trim() || DEFAULT_SETTINGS.folder); if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-"); const path = normalizePath(`${folder}/Handschrift-${stamp}.handwriting.json`);
    await this.app.vault.create(path, JSON.stringify(createDocument(this.settings.defaultPaper), null, 2));
    this.pendingOpenPath = path;
    editor.replaceSelection(`\n\`\`\`handschrift\n${path}\n\`\`\`\n`);
    new Notice("Smooth-Handwriting-Block wurde eingefügt und öffnet sich im Vollbild.");
  }
  private async renderBlock(path: string, element: HTMLElement, context: MarkdownPostProcessorContext): Promise<void> {
    const resolved = this.app.metadataCache.getFirstLinkpathDest(path, context.sourcePath); if (!(resolved instanceof TFile)) { element.createDiv({ cls: "hp-error", text: `Handschriftdatei nicht gefunden: ${path}` }); return; }
    try {
      const result = parseDocument(JSON.parse(await this.app.vault.cachedRead(resolved)) as unknown);
      if (!result) throw new Error("Ungültiges Dateiformat");
      const editor = new InlineHandwritingEditor(element, this, resolved, result.document, result.migrated);
      context.addChild(editor);
      if (this.pendingOpenPath === resolved.path) {
        this.pendingOpenPath = null;
        window.setTimeout(() => editor.openEditor(), 60);
      }
    }
    catch (error) { element.createDiv({ cls: "hp-error", text: `Handschrift konnte nicht geladen werden: ${String(error)}` }); }
  }
  async saveDocument(file: TFile, document: HandwritingDocumentV3): Promise<void> { await this.app.vault.modify(file, JSON.stringify(document)); }
}

class SmoothHandwritingSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: SmoothHandwritingPlugin) { super(app, plugin); }
  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl).setName("Speicherordner").setDesc("Ordner im Vault für Handschrift und PDF-Seitendateien.").addText((text) => text.setValue(this.plugin.settings.folder).onChange(async (value) => { this.plugin.settings.folder = value; await this.plugin.persistSettings(); }));
    new Setting(this.containerEl).setName("Persönliche Wortkorrektur").setDesc("Pause, bevor Originalzüge an Baseline und persönliche Schrifthöhe angepasst werden.").addSlider((slider) => slider.setLimits(400, 1500, 50).setDynamicTooltip().setValue(this.plugin.settings.wordDelay).onChange(async (value) => { this.plugin.settings.wordDelay = value; await this.plugin.persistSettings(); }));
    new Setting(this.containerEl).setName("Automatische Formerkennung").setDesc("Große Geraden, Ellipsen, Rechtecke und Polygone beim Absetzen erkennen.").addToggle((toggle) => toggle.setValue(this.plugin.settings.shapeOptimization).onChange(async (value) => { this.plugin.settings.shapeOptimization = value; await this.plugin.persistSettings(); }));
    new Setting(this.containerEl).setName("Standardpapier").addDropdown((dropdown) => dropdown.addOption("grid", "Kariert").addOption("lines", "Liniert").addOption("blank", "Blanko").setValue(this.plugin.settings.defaultPaper).onChange(async (value) => { this.plugin.settings.defaultPaper = value as Paper; await this.plugin.persistSettings(); }));
    new Setting(this.containerEl).setName("Markerfarbe").addColorPicker((picker) => picker.setValue(this.plugin.settings.markerColor).onChange(async (value) => { this.plugin.settings.markerColor = value; await this.plugin.persistSettings(); }));
    new Setting(this.containerEl).setName("Markerstärke").addSlider((slider) => slider.setLimits(18, 64, 2).setDynamicTooltip().setValue(this.plugin.settings.markerSize).onChange(async (value) => { this.plugin.settings.markerSize = value; await this.plugin.persistSettings(); }));
  }
}
