import { CanvasOperation } from "./model";

export type VisualKind = "flowchart" | "mindmap" | "ui_wireframe" | "research_report" | "math_steps" | "plot";

export interface VisualNodeInput {
  id: string;
  label: string;
  detail?: string;
  parentId?: string;
  role?: "primary" | "secondary" | "decision" | "frame" | "header" | "sidebar" | "card" | "button" | "input" | "text";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface VisualEdgeInput { fromId: string; toId: string; label?: string }
export interface VisualSectionInput { heading: string; body: string }
export interface VisualStepInput { expression: string; explanation?: string }
export interface VisualSeriesInput { label?: string; color?: string; points: Array<{ x: number; y: number }> }

export interface VisualCompositionInput {
  kind: VisualKind;
  id?: string;
  title?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  nodes?: VisualNodeInput[];
  edges?: VisualEdgeInput[];
  sections?: VisualSectionInput[];
  steps?: VisualStepInput[];
  axes?: { xMin: number; xMax: number; yMin: number; yMax: number; xLabel?: string; yLabel?: string };
  series?: VisualSeriesInput[];
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const optionalFinite = (value: unknown): boolean => value === undefined || finite(value);
const cleanId = (value: string): string => value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "item";

export function isVisualComposition(value: unknown): value is VisualCompositionInput {
  if (!value || typeof value !== "object") return false; const input = value as Record<string, unknown>;
  if (!["flowchart", "mindmap", "ui_wireframe", "research_report", "math_steps", "plot"].includes(String(input.kind))) return false;
  if (![input.x, input.y, input.width, input.height].every(optionalFinite)) return false;
  if (input.nodes !== undefined && (!Array.isArray(input.nodes) || input.nodes.length > 40 || input.nodes.some((node) => !node || typeof node !== "object" || typeof node.id !== "string" || typeof node.label !== "string" || !optionalFinite(node.x) || !optionalFinite(node.y) || !optionalFinite(node.width) || !optionalFinite(node.height)))) return false;
  if (input.edges !== undefined && (!Array.isArray(input.edges) || input.edges.length > 80 || input.edges.some((edge) => !edge || typeof edge !== "object" || typeof edge.fromId !== "string" || typeof edge.toId !== "string"))) return false;
  if (input.sections !== undefined && (!Array.isArray(input.sections) || input.sections.length > 20 || input.sections.some((section) => !section || typeof section !== "object" || typeof section.heading !== "string" || typeof section.body !== "string"))) return false;
  if (input.steps !== undefined && (!Array.isArray(input.steps) || input.steps.length > 30 || input.steps.some((step) => !step || typeof step !== "object" || typeof step.expression !== "string"))) return false;
  if (input.series !== undefined && (!Array.isArray(input.series) || input.series.length > 8 || input.series.some((series) => !series || typeof series !== "object" || !Array.isArray(series.points) || series.points.length > 400 || series.points.some((point: Record<string, unknown>) => !point || !finite(point.x) || !finite(point.y))))) return false;
  return true;
}

function idsFor(prefix: string, node: VisualNodeInput): { shape: string; text: string; group: string } {
  const id = cleanId(node.id); return { shape: `${prefix}-${id}`, text: `${prefix}-${id}-label`, group: `${prefix}-${id}-group` };
}

function cardOperations(prefix: string, node: VisualNodeInput, x: number, y: number, width: number, height: number, ellipse = false): CanvasOperation[] {
  const ids = idsFor(prefix, node); const text = node.detail ? `${node.label}\n${node.detail}` : node.label; const fontSize = node.detail ? 18 : 20;
  const emphasized = node.role === "primary" || node.role === "button";
  return [
    { type: "create_shape", id: ids.shape, kind: ellipse ? "ellipse" : "rectangle", x, y, width, height, color: "#080808", strokeWidth: emphasized ? 4 : 2.5, fillColor: emphasized ? "#c0c0c0" : "#ffffff", fillOpacity: emphasized ? 0.32 : 1, radius: ellipse ? undefined : node.role === "button" || node.role === "input" ? 24 : 16 },
    { type: "create_text", id: ids.text, x: x + 16, y: y + Math.max(12, (height - fontSize * (node.detail ? 2.3 : 1.2)) / 2), width: Math.max(60, width - 32), fontSize, color: "#080808", text },
    { type: "group", groupId: ids.group, ids: [ids.shape, ids.text] }
  ];
}

function titleOperations(prefix: string, title: string | undefined, x: number, y: number, width: number): CanvasOperation[] {
  return title ? [{ type: "create_text", id: `${prefix}-title`, x, y, width, fontSize: 34, color: "#080808", text: title }] : [];
}

function flowchart(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const nodes = input.nodes ?? []; const x = input.x ?? -420; const y = input.y ?? -260; const width = input.width ?? 900; const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(nodes.length || 1)))); const cardWidth = Math.min(220, (width - (columns - 1) * 90) / columns); const cardHeight = 108;
  const operations = titleOperations(prefix, input.title, x, y - 70, width); const nodeIds = new Map<string, string>();
  nodes.forEach((node, index) => { const px = node.x ?? x + (index % columns) * (cardWidth + 90); const py = node.y ?? y + Math.floor(index / columns) * 190; const w = node.width ?? cardWidth; const h = node.height ?? cardHeight; operations.push(...cardOperations(prefix, node, px, py, w, h, node.role === "decision")); nodeIds.set(node.id, idsFor(prefix, node).shape); });
  const edges: VisualEdgeInput[] = input.edges ?? nodes.filter((node) => node.parentId).map((node) => ({ fromId: node.parentId!, toId: node.id }));
  for (const [index, edge] of edges.entries()) { const fromId = nodeIds.get(edge.fromId); const toId = nodeIds.get(edge.toId); if (fromId && toId) operations.push({ type: "connect", id: `${prefix}-edge-${index}`, fromId, toId, label: edge.label, color: "#080808", strokeWidth: 2.5 }); }
  return operations;
}

function mindmap(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const nodes = input.nodes ?? []; if (!nodes.length) return titleOperations(prefix, input.title, input.x ?? -180, (input.y ?? 0) - 100, 360);
  const centerX = input.x ?? 0; const centerY = input.y ?? 0; const radiusX = Math.max(320, (input.width ?? 900) / 2); const radiusY = Math.max(220, (input.height ?? 620) / 2); const operations = titleOperations(prefix, input.title, centerX - 220, centerY - radiusY - 100, 440); const nodeIds = new Map<string, string>(); const root = nodes[0];
  nodes.forEach((node, index) => { const angle = index === 0 ? 0 : (index - 1) / Math.max(1, nodes.length - 1) * Math.PI * 2 - Math.PI / 2; const w = node.width ?? (index === 0 ? 220 : 180); const h = node.height ?? (index === 0 ? 110 : 86); const px = node.x ?? (index === 0 ? centerX - w / 2 : centerX + Math.cos(angle) * radiusX - w / 2); const py = node.y ?? (index === 0 ? centerY - h / 2 : centerY + Math.sin(angle) * radiusY - h / 2); operations.push(...cardOperations(prefix, { ...node, role: index === 0 ? "primary" : node.role }, px, py, w, h, true)); nodeIds.set(node.id, idsFor(prefix, node).shape); });
  nodes.slice(1).forEach((node, index) => { const fromId = nodeIds.get(node.parentId ?? root.id); const toId = nodeIds.get(node.id); if (fromId && toId) operations.push({ type: "connect", id: `${prefix}-branch-${index}`, fromId, toId, color: "#404040", strokeWidth: 2 }); });
  for (const [index, edge] of (input.edges ?? []).entries()) { const fromId = nodeIds.get(edge.fromId); const toId = nodeIds.get(edge.toId); if (fromId && toId) operations.push({ type: "connect", id: `${prefix}-edge-${index}`, fromId, toId, label: edge.label, color: "#404040", strokeWidth: 2 }); }
  return operations;
}

function uiWireframe(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const x = input.x ?? -520; const y = input.y ?? -330; const width = input.width ?? 1040; const height = input.height ?? 660; const operations: CanvasOperation[] = [
    { type: "create_shape", id: `${prefix}-screen`, kind: "rectangle", x, y, width, height, color: "#080808", strokeWidth: 4, fillColor: "#ffffff", fillOpacity: 1, radius: 24 },
    ...titleOperations(prefix, input.title, x + 26, y + 22, Math.min(560, width - 52))
  ];
  const nodes = input.nodes ?? []; nodes.forEach((node, index) => {
    const role = node.role ?? "card"; const defaults: Record<string, { w: number; h: number }> = { header: { w: width - 48, h: 76 }, sidebar: { w: 220, h: height - 140 }, card: { w: 250, h: 150 }, button: { w: 160, h: 52 }, input: { w: 260, h: 52 }, text: { w: 300, h: 70 }, frame: { w: 420, h: 280 } }; const size = defaults[role] ?? defaults.card;
    const w = node.width ?? size.w; const h = node.height ?? size.h; const px = node.x ?? x + 30 + (index % 3) * 290; const py = node.y ?? y + 110 + Math.floor(index / 3) * 190;
    if (role === "text") { const id = idsFor(prefix, node).text; operations.push({ type: "create_text", id, x: px, y: py, width: w, fontSize: 22, color: "#080808", text: node.detail ? `${node.label}\n${node.detail}` : node.label }); }
    else operations.push(...cardOperations(prefix, node, px, py, w, h, role === "input"));
  });
  operations.push({ type: "reorder", ids: [`${prefix}-screen`], direction: "back" }); return operations;
}

function researchReport(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const x = input.x ?? -500; const y = input.y ?? -340; const width = input.width ?? 1000; const sections = input.sections ?? []; const columns = sections.length > 3 ? 2 : 1; const cardWidth = (width - (columns - 1) * 34) / columns; const operations = titleOperations(prefix, input.title ?? "Research brief", x, y, width);
  sections.forEach((section, index) => { const column = index % columns; const row = Math.floor(index / columns); const node: VisualNodeInput = { id: `section-${index}`, label: section.heading, detail: section.body, role: index === 0 ? "primary" : "card" }; operations.push(...cardOperations(prefix, node, x + column * (cardWidth + 34), y + 90 + row * 210, cardWidth, 174)); });
  return operations;
}

function mathSteps(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const x = input.x ?? -380; const y = input.y ?? -300; const width = input.width ?? 760; const operations = titleOperations(prefix, input.title ?? "Rechenweg", x, y, width); const steps = input.steps ?? [];
  steps.forEach((step, index) => { const node: VisualNodeInput = { id: `step-${index}`, label: `${index + 1}. ${step.expression}`, detail: step.explanation, role: index === steps.length - 1 ? "primary" : "card" }; operations.push(...cardOperations(prefix, node, x, y + 82 + index * 142, width, 112)); if (index > 0) operations.push({ type: "connect", id: `${prefix}-step-edge-${index}`, fromId: `${prefix}-step-${index - 1}`, toId: `${prefix}-step-${index}`, color: "#404040", strokeWidth: 2 }); });
  return operations;
}

function plot(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const x = input.x ?? -460; const y = input.y ?? -300; const width = input.width ?? 920; const height = input.height ?? 600; const axes = input.axes ?? { xMin: -10, xMax: 10, yMin: -10, yMax: 10 }; const padding = 74; const left = x + padding; const right = x + width - 28; const top = y + 72; const bottom = y + height - padding; const mapX = (value: number) => left + (value - axes.xMin) / Math.max(0.0001, axes.xMax - axes.xMin) * (right - left); const mapY = (value: number) => bottom - (value - axes.yMin) / Math.max(0.0001, axes.yMax - axes.yMin) * (bottom - top); const operations: CanvasOperation[] = [
    { type: "create_shape", id: `${prefix}-plot-frame`, kind: "rectangle", x, y, width, height, color: "#080808", strokeWidth: 2, fillColor: "#ffffff", fillOpacity: 1, radius: 22 },
    ...titleOperations(prefix, input.title ?? "Graph", x + 24, y + 18, width - 48),
    { type: "create_stroke", id: `${prefix}-x-axis`, color: "#080808", size: 2, points: [{ x: left, y: mapY(Math.max(axes.yMin, Math.min(axes.yMax, 0))), pressure: 0.5 }, { x: right, y: mapY(Math.max(axes.yMin, Math.min(axes.yMax, 0))), pressure: 0.5 }] },
    { type: "create_stroke", id: `${prefix}-y-axis`, color: "#080808", size: 2, points: [{ x: mapX(Math.max(axes.xMin, Math.min(axes.xMax, 0))), y: bottom, pressure: 0.5 }, { x: mapX(Math.max(axes.xMin, Math.min(axes.xMax, 0))), y: top, pressure: 0.5 }] }
  ];
  if (axes.xLabel) operations.push({ type: "create_text", id: `${prefix}-x-label`, x: right - 100, y: bottom + 18, width: 100, fontSize: 16, text: axes.xLabel, color: "#404040" });
  if (axes.yLabel) operations.push({ type: "create_text", id: `${prefix}-y-label`, x: left + 12, y: top, width: 120, fontSize: 16, text: axes.yLabel, color: "#404040" });
  const colors = ["#2457e6", "#c62828", "#16833b", "#7c3aed", "#080808"];
  (input.series ?? []).forEach((series, index) => { if (series.points.length < 2) return; const id = `${prefix}-series-${index}`; operations.push({ type: "create_stroke", id, color: series.color ?? colors[index % colors.length], size: 3, points: series.points.map((point) => ({ x: mapX(point.x), y: mapY(point.y), pressure: 0.5 })) }); if (series.label) operations.push({ type: "create_text", id: `${id}-label`, x: right - 150, y: top + index * 28, width: 140, fontSize: 16, text: series.label, color: series.color ?? colors[index % colors.length] }); });
  operations.push({ type: "reorder", ids: [`${prefix}-plot-frame`], direction: "back" }); return operations;
}

export function composeVisual(input: VisualCompositionInput): CanvasOperation[] {
  const prefix = cleanId(input.id ?? `visual-${crypto.randomUUID()}`);
  if (input.kind === "flowchart") return flowchart(input, prefix);
  if (input.kind === "mindmap") return mindmap(input, prefix);
  if (input.kind === "ui_wireframe") return uiWireframe(input, prefix);
  if (input.kind === "research_report") return researchReport(input, prefix);
  if (input.kind === "math_steps") return mathSteps(input, prefix);
  return plot(input, prefix);
}
