import { CanvasOperation } from "./model";
import { TextBlock, measureTextBlock } from "./measure";
import { accentTints, accents, palette, radius, spacing, typeScale } from "./theme";
import { Repair, repairComposition } from "./repair";

export type VisualKind = "flowchart" | "mindmap" | "ui_wireframe" | "ui_mockup" | "research_report" | "math_steps" | "plot" | "study_note" | "timeline" | "comparison" | "hierarchy" | "visual_explainer" | "guided_explainer";

export interface VisualNodeInput {
  id: string;
  label: string;
  detail?: string;
  parentId?: string;
  role?: "primary" | "secondary" | "decision" | "frame" | "screen" | "header" | "navbar" | "sidebar" | "section" | "card" | "button" | "input" | "checkbox" | "radio" | "switch" | "select" | "tabs" | "list" | "modal" | "badge" | "avatar" | "divider" | "icon" | "callout" | "legend" | "example" | "warning" | "source" | "text";
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
  presentationSteps?: Array<{ title: string; body?: string; focusIds: string[]; revealIds?: string[] }>;
  theme?: { background?: string; surface?: string; text?: string; accent?: string };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const optionalFinite = (value: unknown): boolean => value === undefined || finite(value);
const cleanId = (value: string): string => value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "item";

export function isVisualComposition(value: unknown): value is VisualCompositionInput {
  if (!value || typeof value !== "object") return false; const input = value as Record<string, unknown>;
  if (!["flowchart", "mindmap", "ui_wireframe", "ui_mockup", "research_report", "math_steps", "plot", "study_note", "timeline", "comparison", "hierarchy", "visual_explainer", "guided_explainer"].includes(String(input.kind))) return false;
  if (![input.x, input.y, input.width, input.height].every(optionalFinite)) return false;
  if (input.nodes !== undefined && (!Array.isArray(input.nodes) || input.nodes.length > 40 || input.nodes.some((node) => !node || typeof node !== "object" || typeof node.id !== "string" || typeof node.label !== "string" || !optionalFinite(node.x) || !optionalFinite(node.y) || !optionalFinite(node.width) || !optionalFinite(node.height)))) return false;
  if (input.edges !== undefined && (!Array.isArray(input.edges) || input.edges.length > 80 || input.edges.some((edge) => !edge || typeof edge !== "object" || typeof edge.fromId !== "string" || typeof edge.toId !== "string"))) return false;
  if (input.sections !== undefined && (!Array.isArray(input.sections) || input.sections.length > 20 || input.sections.some((section) => !section || typeof section !== "object" || typeof section.heading !== "string" || typeof section.body !== "string"))) return false;
  if (input.steps !== undefined && (!Array.isArray(input.steps) || input.steps.length > 30 || input.steps.some((step) => !step || typeof step !== "object" || typeof step.expression !== "string"))) return false;
  if (input.series !== undefined && (!Array.isArray(input.series) || input.series.length > 8 || input.series.some((series) => !series || typeof series !== "object" || !Array.isArray(series.points) || series.points.length > 400 || series.points.some((point: Record<string, unknown>) => !point || !finite(point.x) || !finite(point.y))))) return false;
  if (input.presentationSteps !== undefined && (!Array.isArray(input.presentationSteps) || input.presentationSteps.length > 40 || input.presentationSteps.some((step) => !step || typeof step !== "object" || typeof step.title !== "string" || !Array.isArray(step.focusIds) || step.focusIds.some((id: unknown) => typeof id !== "string")))) return false;
  return true;
}

function idsFor(prefix: string, node: VisualNodeInput): { shape: string; text: string; group: string } {
  const id = cleanId(node.id); return { shape: `${prefix}-${id}`, text: `${prefix}-${id}-label`, group: `${prefix}-${id}-group` };
}

const CARD_PADDING = spacing.md;
/** Composed text is applied by the agent, and the store renders agent text in the handwriting face: measure that face. */
const AGENT_FONT = "handwriting" as const;

const cardText = (node: VisualNodeInput): string => node.detail ? `${node.label}\n${node.detail}` : node.label;
const cardFontSize = (node: VisualNodeInput): number => node.detail ? typeScale.detail.fontSize : typeScale.body.fontSize;
const cardTextWidth = (width: number): number => Math.max(60, width - CARD_PADDING * 2);

/** How tall a card has to be for its own text — measured with the renderer's font, not guessed. */
export function cardHeight(node: VisualNodeInput, width: number, minimum = 96): number {
  const measured = measureTextBlock({ text: cardText(node), width: cardTextWidth(width), fontSize: cardFontSize(node), fontFamily: AGENT_FONT });
  return Math.max(minimum, Math.round(measured.height + CARD_PADDING * 2));
}

/** Narrowest a card may be before an unbreakable word spills out of it. */
export function cardMinimumWidth(node: VisualNodeInput): number {
  const measured = measureTextBlock({ text: cardText(node), width: 10000, fontSize: cardFontSize(node), fontFamily: AGENT_FONT });
  return Math.ceil(measured.longestWord + CARD_PADDING * 2);
}

/** Row heights for a grid of cards: every row is as tall as its tallest card, never a fixed stride. */
function gridRowHeights(nodes: VisualNodeInput[], columns: number, cardWidth: (node: VisualNodeInput) => number, minimum: number): number[] {
  const heights: number[] = [];
  nodes.forEach((node, index) => {
    const row = Math.floor(index / columns); const height = node.height ?? cardHeight(node, cardWidth(node), minimum);
    heights[row] = Math.max(heights[row] ?? 0, height);
  });
  return heights;
}

/** Axis and legend labels are captions: one line, truncated rather than allowed to cover the plot. */
const caption = (text: string, limit = 34): string => text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

const rowOffset = (heights: number[], row: number, gap: number): number => heights.slice(0, row).reduce((total, height) => total + height + gap, 0);

/** Height a sticky note needs for its text, matching the padding the store gives note bodies. */
function noteHeight(text: string, width: number, blockStyle?: TextBlock["blockStyle"], minimum = 90): number {
  return Math.max(minimum, Math.round(measureTextBlock({ text, width: Math.max(84, width - 36), fontSize: 24, blockStyle, fontFamily: AGENT_FONT }).height + 36));
}

function cardOperations(prefix: string, node: VisualNodeInput, x: number, y: number, width: number, height: number, ellipse = false, accent?: string): CanvasOperation[] {
  const ids = idsFor(prefix, node); const text = cardText(node); const fontSize = cardFontSize(node);
  const emphasized = node.role === "primary" || node.role === "button";
  const textWidth = cardTextWidth(width);
  const measured = measureTextBlock({ text, width: textWidth, fontSize, fontFamily: AGENT_FONT });
  const boxHeight = Math.max(height, Math.round(measured.height + CARD_PADDING * 2));
  return [
    { type: "create_shape", id: ids.shape, kind: ellipse ? "ellipse" : "rectangle", x, y, width, height: boxHeight, color: accent ?? palette.ink, strokeWidth: emphasized ? 4 : 2.5, fillColor: accent ? accentTints[accents.indexOf(accent as typeof accents[number])] ?? palette.surface : emphasized ? palette.hairline : palette.surface, fillOpacity: accent ? 1 : emphasized ? 0.32 : 1, radius: ellipse ? undefined : node.role === "button" || node.role === "input" ? radius.control : radius.card },
    { type: "create_text", id: ids.text, x: x + CARD_PADDING, y: y + Math.max(CARD_PADDING * .6, (boxHeight - measured.height) / 2), width: textWidth, fontSize, color: palette.ink, text },
    { type: "group", groupId: ids.group, ids: [ids.shape, ids.text] }
  ];
}

/** How much room the composed title actually takes, so content can start below it. */
function titleBlockHeight(title: string | undefined, width: number): number {
  return title ? measureTextBlock({ text: title, width, fontSize: typeScale.title.fontSize, fontWeight: typeScale.title.fontWeight, blockStyle: "heading-1", fontFamily: AGENT_FONT }).height : 0;
}

function titleOperations(prefix: string, title: string | undefined, x: number, y: number, width: number): CanvasOperation[] {
  return title ? [{ type: "create_text", id: `${prefix}-title`, x, y, width, fontSize: typeScale.title.fontSize, color: palette.ink, text: title, fontWeight: typeScale.title.fontWeight, blockStyle: "heading-1", renderStyle: "sketch" }] : [];
}

function flowchart(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const nodes = input.nodes ?? []; const x = input.x ?? -420; const y = input.y ?? -260; const width = input.width ?? 900; const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(nodes.length || 1)))); const cardWidth = Math.min(220, (width - (columns - 1) * 90) / columns);
  const heights = gridRowHeights(nodes, columns, (node) => node.width ?? cardWidth, 96);
  const operations = titleOperations(prefix, input.title, x, y - Math.max(70, titleBlockHeight(input.title, width) + spacing.lg), width); const nodeIds = new Map<string, string>();
  nodes.forEach((node, index) => { const row = Math.floor(index / columns); const px = node.x ?? x + (index % columns) * (cardWidth + 90); const py = node.y ?? y + rowOffset(heights, row, 82); const w = node.width ?? Math.max(cardWidth, cardMinimumWidth(node)); const h = node.height ?? heights[row]; operations.push(...cardOperations(prefix, node, px, py, w, h, node.role === "decision", node.role === "decision" ? palette.info : undefined)); nodeIds.set(node.id, idsFor(prefix, node).shape); });
  const edges: VisualEdgeInput[] = input.edges ?? nodes.filter((node) => node.parentId).map((node) => ({ fromId: node.parentId!, toId: node.id }));
  for (const [index, edge] of edges.entries()) { const fromId = nodeIds.get(edge.fromId); const toId = nodeIds.get(edge.toId); if (fromId && toId) operations.push({ type: "connect", id: `${prefix}-edge-${index}`, fromId, toId, label: edge.label, color: palette.ink, strokeWidth: 2.5, route: "orthogonal" }); }
  return operations;
}

function mindmap(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const nodes = input.nodes ?? []; if (!nodes.length) return titleOperations(prefix, input.title, input.x ?? -180, (input.y ?? 0) - 100, 360);
  const centerX = input.x ?? 0; const centerY = input.y ?? 0;
  // The ring has to be big enough for the bubbles it carries, otherwise every branch collides.
  const ring = nodes.slice(1);
  const ringWidth = ring.reduce((widest, node) => Math.max(widest, node.width ?? Math.max(180, cardMinimumWidth(node))), 180);
  const ringHeight = ring.reduce((tallest, node) => Math.max(tallest, node.height ?? cardHeight(node, node.width ?? 180, 86)), 86);
  const spread = Math.max(1, ring.length) * (ringWidth + spacing.lg) / (2 * Math.PI);
  const radiusX = Math.max(320, (input.width ?? 900) / 2, spread + ringWidth / 2); const radiusY = Math.max(220, (input.height ?? 620) / 2, spread * .8 + ringHeight / 2); const operations = titleOperations(prefix, input.title, centerX - 220, centerY - radiusY - Math.max(100, titleBlockHeight(input.title, 440) + spacing.lg), 440); const nodeIds = new Map<string, string>(); const root = nodes[0];
  nodes.forEach((node, index) => { const angle = index === 0 ? 0 : (index - 1) / Math.max(1, nodes.length - 1) * Math.PI * 2 - Math.PI / 2; const w = node.width ?? Math.max(index === 0 ? 220 : 180, cardMinimumWidth(node)); const h = node.height ?? cardHeight(node, w, index === 0 ? 110 : 86); const px = node.x ?? (index === 0 ? centerX - w / 2 : centerX + Math.cos(angle) * radiusX - w / 2); const py = node.y ?? (index === 0 ? centerY - h / 2 : centerY + Math.sin(angle) * radiusY - h / 2); operations.push(...cardOperations(prefix, { ...node, role: index === 0 ? "primary" : node.role }, px, py, w, h, true, index === 0 ? undefined : accents[(index - 1) % accents.length])); nodeIds.set(node.id, idsFor(prefix, node).shape); });
  nodes.slice(1).forEach((node, index) => { const fromId = nodeIds.get(node.parentId ?? root.id); const toId = nodeIds.get(node.id); if (fromId && toId) operations.push({ type: "connect", id: `${prefix}-branch-${index}`, fromId, toId, color: accents[index % accents.length], strokeWidth: 2, route: "curved" }); });
  for (const [index, edge] of (input.edges ?? []).entries()) { const fromId = nodeIds.get(edge.fromId); const toId = nodeIds.get(edge.toId); if (fromId && toId) operations.push({ type: "connect", id: `${prefix}-edge-${index}`, fromId, toId, label: edge.label, color: palette.muted, strokeWidth: 2, route: "curved" }); }
  return operations;
}

const FULL_WIDTH_ROLES = ["header", "navbar", "divider", "tabs"];

function uiWireframe(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const x = input.x ?? -520; const y = input.y ?? -330; const width = input.width ?? 1040;
  const theme = { background: input.theme?.background ?? palette.surface, surface: input.theme?.surface ?? palette.surface, text: input.theme?.text ?? palette.ink, accent: input.theme?.accent ?? palette.ink };
  const artboardId = `${prefix}-screen-border`;
  const defaults: Record<string, { w: number; h: number }> = { header: { w: width - 60, h: 76 }, navbar: { w: width - 60, h: 68 }, sidebar: { w: 220, h: 320 }, section: { w: 520, h: 260 }, card: { w: 250, h: 150 }, button: { w: 180, h: 56 }, input: { w: 260, h: 56 }, checkbox: { w: 180, h: 48 }, radio: { w: 180, h: 48 }, switch: { w: 120, h: 48 }, select: { w: 240, h: 56 }, tabs: { w: width - 60, h: 52 }, list: { w: 320, h: 220 }, modal: { w: 440, h: 300 }, badge: { w: 110, h: 42 }, avatar: { w: 72, h: 72 }, divider: { w: width - 60, h: 12 }, icon: { w: 48, h: 48 }, text: { w: 300, h: 70 }, frame: { w: 420, h: 280 } };
  const nodes = input.nodes ?? []; const margin = 30; const gap = spacing.md;
  const left = x + margin; const right = x + width - margin;
  // Flow the components instead of forcing them into three fixed columns.
  // The flow starts below the artboard title, however many lines that title needs.
  const titleHeight = input.title ? measureTextBlock({ text: input.title, width: width - 36, fontSize: 28, fontWeight: 700, blockStyle: "heading-2", fontFamily: "sans" }).height : 0;
  let flowLeft = left; let cursorX = left; let cursorY = y + Math.max(110, 12 + titleHeight + spacing.lg); let rowHeight = 0; let lowest = cursorY;
  const placed = nodes.map((node) => {
    const role = node.role ?? "card"; const size = defaults[role] ?? defaults.card;
    const w = node.width ?? Math.min(Math.max(size.w, role === "text" ? 0 : cardMinimumWidth(node)), right - flowLeft);
    const h = node.height ?? (role === "text" ? size.h : Math.max(size.h, cardHeight(node, w, 0)));
    if (node.x !== undefined && node.y !== undefined) { lowest = Math.max(lowest, node.y + h); return { node, role, x: node.x, y: node.y, w, h }; }
    if (role === "sidebar") {
      const placement = { node, role, x: left, y: cursorY, w, h: node.height ?? Math.max(size.h, cardHeight(node, w, 0)) };
      flowLeft = left + w + gap; cursorX = flowLeft; lowest = Math.max(lowest, placement.y + placement.h); return placement;
    }
    if (FULL_WIDTH_ROLES.includes(role)) {
      if (rowHeight) { cursorY += rowHeight + gap; rowHeight = 0; }
      const placement = { node, role, x: flowLeft, y: cursorY, w: node.width ?? right - flowLeft, h };
      cursorY += h + gap; cursorX = flowLeft; lowest = Math.max(lowest, placement.y + h); return placement;
    }
    if (cursorX > flowLeft && cursorX + w > right) { cursorY += rowHeight + gap; cursorX = flowLeft; rowHeight = 0; }
    const placement = { node, role, x: cursorX, y: cursorY, w, h };
    cursorX += w + gap; rowHeight = Math.max(rowHeight, h); lowest = Math.max(lowest, cursorY + h);
    return placement;
  });
  const height = input.height ?? Math.max(360, lowest - y + margin);
  const operations: CanvasOperation[] = [
    { type: "create_frame", id: `${prefix}-screen`, x, y, width, height, title: input.title, color: theme.text, backgroundColor: theme.background, artboardPreset: width < 600 ? "mobile" : "desktop", semanticRole: "artboard", name: input.title ?? "UI mockup" }
  ];
  for (const placement of placed) {
    const { node, role, w, h } = placement;
    if (role === "text") {
      operations.push({ type: "create_text", id: idsFor(prefix, node).text, x: placement.x, y: placement.y, width: w, fontSize: typeScale.detail.fontSize, color: theme.text, text: node.detail ? `${node.label}\n${node.detail}` : node.label, semanticRole: role, parentId: artboardId });
      continue;
    }
    const card = cardOperations(prefix, node, placement.x, placement.y, w, h, role === "input" || role === "avatar");
    for (const operation of card) {
      if (operation.type === "create_shape" || operation.type === "create_text") operation.parentId = artboardId;
      if (operation.type === "create_shape") { operation.semanticRole = role; operation.fillColor = role === "button" ? theme.accent : theme.surface; operation.fillOpacity = 1; }
      if (operation.type === "create_text") operation.color = role === "button" && relativeContrast(theme.accent) ? palette.surface : theme.text;
    }
    operations.push(...card);
  }
  operations.push({ type: "reorder", ids: [artboardId], direction: "back" });
  return operations;
}

/** True when a fill is dark enough that its label has to be light. */
function relativeContrast(colour: string): boolean {
  const match = /^#([0-9a-f]{6})$/i.exec(colour); if (!match) return false;
  const value = Number.parseInt(match[1], 16);
  const luminance = ((value >> 16 & 255) * .2126 + (value >> 8 & 255) * .7152 + (value & 255) * .0722) / 255;
  return luminance < .5;
}

function researchReport(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const x = input.x ?? -500; const y = input.y ?? -340; const width = input.width ?? 1000; const sections = input.sections ?? []; const columns = sections.length > 3 ? 2 : 1; const cardWidth = (width - (columns - 1) * 34) / columns; const operations = titleOperations(prefix, input.title ?? "Research brief", x, y, width);
  const nodes: VisualNodeInput[] = sections.map((section, index) => ({ id: `section-${index}`, label: section.heading, detail: section.body, role: index === 0 ? "primary" : "card" }));
  const heights = gridRowHeights(nodes, columns, () => cardWidth, 140);
  const briefTop = Math.max(90, titleBlockHeight(input.title ?? "Research brief", width) + spacing.lg);
  nodes.forEach((node, index) => { const column = index % columns; const row = Math.floor(index / columns); operations.push(...cardOperations(prefix, node, x + column * (cardWidth + 34), y + briefTop + rowOffset(heights, row, 36), cardWidth, heights[row])); });
  return operations;
}

function mathSteps(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const x = input.x ?? -380; const y = input.y ?? -300; const width = input.width ?? 760; const operations = titleOperations(prefix, input.title ?? "Calculation steps", x, y, width); const steps = input.steps ?? [];
  const stepNodes: VisualNodeInput[] = steps.map((step, index) => ({ id: `step-${index}`, label: `${index + 1}. ${step.expression}`, detail: step.explanation, role: index === steps.length - 1 ? "primary" : "card" }));
  let cursor = y + Math.max(82, titleBlockHeight(input.title ?? "Calculation steps", width) + spacing.lg);
  stepNodes.forEach((node, index) => { const height = cardHeight(node, width, 96); operations.push(...cardOperations(prefix, node, x, cursor, width, height)); cursor += height + spacing.lg; if (index > 0) operations.push({ type: "connect", id: `${prefix}-step-edge-${index}`, fromId: `${prefix}-step-${index - 1}`, toId: `${prefix}-step-${index}`, color: palette.muted, strokeWidth: 2 }); });
  return operations;
}

function plot(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const x = input.x ?? -460; const y = input.y ?? -300; const width = input.width ?? 920; const axes = input.axes ?? { xMin: -10, xMax: 10, yMin: -10, yMax: 10 }; const padding = 74;
  // The plot area starts under the title, however many lines it takes, and the frame grows with it.
  const titleHeight = measureTextBlock({ text: input.title ?? "Graph", width: width - 48, fontSize: typeScale.title.fontSize, fontWeight: typeScale.title.fontWeight, blockStyle: "heading-1", fontFamily: AGENT_FONT }).height;
  const series = (input.series ?? []).filter((entry) => entry.points.length >= 2);
  const legendRows = Math.ceil(series.filter((entry) => entry.label).length / 2);
  const legendHeight = legendRows * 28 + (legendRows ? spacing.sm : 0);
  const height = Math.max(input.height ?? 600, Math.round(titleHeight + 420 + legendHeight));
  const left = x + padding; const right = x + width - 28; const top = y + 18 + titleHeight + spacing.md; const bottom = y + height - padding - legendHeight; const mapX = (value: number) => left + (value - axes.xMin) / Math.max(0.0001, axes.xMax - axes.xMin) * (right - left); const mapY = (value: number) => bottom - (value - axes.yMin) / Math.max(0.0001, axes.yMax - axes.yMin) * (bottom - top); const operations: CanvasOperation[] = [
    { type: "create_shape", id: `${prefix}-plot-frame`, kind: "rectangle", x, y, width, height, color: "#080808", strokeWidth: 2, fillColor: "#ffffff", fillOpacity: 1, radius: 22 },
    ...titleOperations(prefix, input.title ?? "Graph", x + 24, y + 18, width - 48),
    { type: "create_stroke", id: `${prefix}-x-axis`, color: "#080808", size: 2, points: [{ x: left, y: mapY(Math.max(axes.yMin, Math.min(axes.yMax, 0))), pressure: 0.5 }, { x: right, y: mapY(Math.max(axes.yMin, Math.min(axes.yMax, 0))), pressure: 0.5 }] },
    { type: "create_stroke", id: `${prefix}-y-axis`, color: "#080808", size: 2, points: [{ x: mapX(Math.max(axes.xMin, Math.min(axes.xMax, 0))), y: bottom, pressure: 0.5 }, { x: mapX(Math.max(axes.xMin, Math.min(axes.xMax, 0))), y: top, pressure: 0.5 }] }
  ];
  if (axes.xLabel) operations.push({ type: "create_text", id: `${prefix}-x-label`, x: right - 160, y: bottom + 18, width: 160, fontSize: 16, text: caption(axes.xLabel, 22), color: palette.muted, textAlign: "right" });
  if (axes.yLabel) operations.push({ type: "create_text", id: `${prefix}-y-label`, x: left + 12, y: top - 4, width: 140, fontSize: 16, text: caption(axes.yLabel, 18), color: palette.muted });
  const colors = ["#2457e6", "#c62828", "#16833b", "#7c3aed", "#080808"];
  let legendIndex = 0;
  series.forEach((series, index) => { const id = `${prefix}-series-${index}`; operations.push({ type: "create_stroke", id, color: series.color ?? colors[index % colors.length], size: 3, points: series.points.map((point) => ({ x: mapX(point.x), y: mapY(point.y), pressure: 0.5 })) }); if (series.label) { const column = legendIndex % 2; const row = Math.floor(legendIndex / 2); legendIndex += 1; const columnWidth = (right - left - spacing.md) / 2; operations.push({ type: "create_text", id: `${id}-label`, x: left + column * (columnWidth + spacing.md), y: bottom + padding - legendHeight + spacing.sm + row * 28, width: columnWidth, fontSize: 16, text: caption(series.label, 30), color: series.color ?? colors[index % colors.length] }); } });
  operations.push({ type: "reorder", ids: [`${prefix}-plot-frame`], direction: "back" }); return operations;
}

function studyNote(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const x = input.x ?? -470; const y = input.y ?? -320; const width = input.width ?? 940; const sections = input.sections ?? [];
  const blocks = sections.map((section) => ({
    heading: measureTextBlock({ text: section.heading, width: width - 56, fontSize: typeScale.heading.fontSize, fontWeight: typeScale.heading.fontWeight, blockStyle: "heading-2", fontFamily: AGENT_FONT }).height,
    body: measureTextBlock({ text: section.body, width: width - 84, fontSize: typeScale.subheading.fontSize, blockStyle: "bullet", fontFamily: AGENT_FONT }).height
  }));
  const pageTitleHeight = measureTextBlock({ text: input.title ?? "Study notes", width: width - 36, fontSize: 28, fontWeight: 700, blockStyle: "heading-2", fontFamily: AGENT_FONT }).height;
  const contentTop = Math.max(88, 12 + pageTitleHeight + spacing.md);
  const pageHeight = input.height ?? Math.max(320, contentTop + spacing.lg + blocks.reduce((total, block) => total + block.heading + block.body + spacing.md + spacing.lg, 0));
  const operations: CanvasOperation[] = [{ type: "create_frame", id: `${prefix}-page`, x, y, width, height: pageHeight, title: input.title ?? "Study notes", renderStyle: "sketch" }];
  let noteCursor = y + contentTop;
  sections.forEach((section, index) => {
    const block = blocks[index];
    operations.push({ type: "create_text", id: `${prefix}-heading-${index}`, x: x + 28, y: noteCursor, width: width - 56, text: section.heading, fontSize: typeScale.heading.fontSize, fontWeight: typeScale.heading.fontWeight, blockStyle: "heading-2", highlightColor: index === 0 ? palette.highlight : undefined, renderStyle: "sketch" }, { type: "create_text", id: `${prefix}-body-${index}`, x: x + 42, y: noteCursor + block.heading + spacing.xs, width: width - 84, text: section.body, fontSize: typeScale.subheading.fontSize, blockStyle: "bullet", renderStyle: "sketch" });
    noteCursor += block.heading + block.body + spacing.md + spacing.lg;
  });
  return operations;
}

function timeline(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const nodes = input.nodes ?? []; const x = input.x ?? -480; const y = input.y ?? -100; // Events alternate above and below the axis, so neighbours need half an event card of room each.
  const width = input.width ?? 960; const span = Math.max(width, (nodes.length - 1) * 230); const gap = span / Math.max(1, nodes.length - 1); const operations = titleOperations(prefix, input.title ?? "Timeline", x, y - Math.max(130, titleBlockHeight(input.title ?? "Timeline", width) + spacing.xl), width);
  if (nodes.length > 1) operations.push({ type: "create_arrow", id: `${prefix}-axis`, from: { x, y }, to: { x: x + span, y }, color: palette.muted, strokeWidth: 3 });
  nodes.forEach((node, index) => { const px = x + gap * index; operations.push({ type: "create_shape", id: `${prefix}-dot-${index}`, kind: "ellipse", x: px - 8, y: y - 8, width: 16, height: 16, color: accents[index % accents.length], filled: true, fillColor: accents[index % accents.length], fillOpacity: 1 }, { type: "create_note", id: `${prefix}-event-${index}`, x: px - 105, y: y + (index % 2 ? 44 : -180), width: 210, height: noteHeight(node.detail ? `${node.label}\n${node.detail}` : node.label, 210, undefined, 112), text: node.detail ? `${node.label}\n${node.detail}` : node.label, fillColor: palette.surface, renderStyle: "sketch" }); }); return operations;
}

function comparison(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const sections = input.sections ?? []; const x = input.x ?? -460; const y = input.y ?? -300; const width = input.width ?? 920; const columns = Math.max(2, Math.min(4, sections.length || 2)); const operations = titleOperations(prefix, input.title ?? "Comparison", x, y, width); const columnWidth = (width - 24 * (columns - 1)) / columns;
  const columnHeight = input.height ?? sections.reduce((tallest, section) => Math.max(tallest, noteHeight(`${section.heading}\n${section.body}`, columnWidth, "bullet", 200)), 200);
  sections.forEach((section, index) => operations.push({ type: "create_note", id: `${prefix}-column-${index}`, x: x + index * (columnWidth + 24), y: y + Math.max(72, titleBlockHeight(input.title ?? "Comparison", width) + spacing.lg), width: columnWidth, height: columnHeight, text: `${section.heading}\n${section.body}`, blockStyle: "bullet", fillColor: accentTints[index % accentTints.length], renderStyle: "sketch" })); return operations;
}

function visualExplainer(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  const nodes = input.nodes ?? []; const x = input.x ?? -450; const y = input.y ?? -300; const width = input.width ?? 900;
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(nodes.length || 1)))); const cardWidth = (width - 70 - (columns - 1) * 28) / columns;
  const ideaText = (node: VisualNodeInput): string => node.detail ? `${node.label}\n${node.detail}` : node.label;
  const heights: number[] = [];
  nodes.forEach((node, index) => { const row = Math.floor(index / columns); heights[row] = Math.max(heights[row] ?? 0, noteHeight(ideaText(node), cardWidth, undefined, 120)); });
  const explainerTitleHeight = measureTextBlock({ text: input.title ?? "Visual explanation", width: width - 36, fontSize: 28, fontWeight: 700, blockStyle: "heading-2", fontFamily: AGENT_FONT }).height;
  const ideasTop = Math.max(90, 12 + explainerTitleHeight + spacing.md);
  const contentHeight = heights.length ? rowOffset(heights, heights.length, spacing.lg) + ideasTop + spacing.md : 240;
  const operations: CanvasOperation[] = [{ type: "create_frame", id: `${prefix}-frame`, x, y, width, height: input.height ?? Math.max(320, contentHeight), title: input.title ?? "Visual explanation", renderStyle: "sketch" }];
  nodes.forEach((node, index) => { const row = Math.floor(index / columns); const px = x + 28 + (index % columns) * (cardWidth + 28); const py = y + ideasTop + rowOffset(heights, row, spacing.lg); operations.push({ type: "create_note", id: `${prefix}-idea-${index}`, x: px, y: py, width: cardWidth, height: heights[row], text: ideaText(node), fillColor: index === 0 ? palette.note : palette.surface, renderStyle: "sketch" }); });
  return operations;
}

function layoutVisual(input: VisualCompositionInput, prefix: string): CanvasOperation[] {
  if (input.kind === "flowchart") return flowchart(input, prefix);
  if (input.kind === "mindmap") return mindmap(input, prefix);
  if (input.kind === "ui_wireframe" || input.kind === "ui_mockup") return uiWireframe(input, prefix);
  if (input.kind === "research_report") return researchReport(input, prefix);
  if (input.kind === "math_steps") return mathSteps(input, prefix);
  if (input.kind === "study_note") return studyNote(input, prefix);
  if (input.kind === "timeline") return timeline(input, prefix);
  if (input.kind === "comparison") return comparison(input, prefix);
  if (input.kind === "hierarchy") {
    const sourceNodes = input.nodes ?? [];
    const nodes = sourceNodes.map((node, index) => ({ ...node, parentId: node.parentId ?? (index > 0 ? sourceNodes[Math.floor((index - 1) / 2)]?.id : undefined) }));
    return flowchart({ ...input, kind: "flowchart", nodes }, prefix);
  }
  if (input.kind === "visual_explainer" || input.kind === "guided_explainer") return visualExplainer(input, prefix);
  return plot(input, prefix);
}

/** Step cameras are read off the finished geometry, so they point at where the notes ended up. */
function explanationSequence(input: VisualCompositionInput, prefix: string, operations: CanvasOperation[]): CanvasOperation | null {
  const nodes = input.nodes ?? [];
  const resolve = (id: string): string[] => { const index = nodes.findIndex((node) => node.id === id); return index < 0 ? [id] : [`${prefix}-idea-${index}-card`, `${prefix}-idea-${index}-text`]; };
  const placed = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
  for (const operation of operations) if (operation.type === "create_note" && operation.id) {
    const box = { minX: operation.x, minY: operation.y, maxX: operation.x + (operation.width ?? 260), maxY: operation.y + (operation.height ?? 145) };
    placed.set(`${operation.id}-card`, box); placed.set(`${operation.id}-text`, box);
  }
  const cameraFor = (elementIds: string[]): { minX: number; minY: number; maxX: number; maxY: number } | undefined => {
    const boxes = elementIds.map((id) => placed.get(id)).filter((box): box is NonNullable<typeof box> => Boolean(box));
    if (!boxes.length) return undefined;
    const margin = spacing.xl;
    return { minX: Math.min(...boxes.map((box) => box.minX)) - margin, minY: Math.min(...boxes.map((box) => box.minY)) - margin, maxX: Math.max(...boxes.map((box) => box.maxX)) + margin, maxY: Math.max(...boxes.map((box) => box.maxY)) + margin };
  };
  const steps = (input.presentationSteps?.length
    ? input.presentationSteps.map((step, index) => ({ id: `${prefix}-step-${index}`, title: step.title, body: step.body, focusElementIds: step.focusIds.flatMap(resolve), revealElementIds: (step.revealIds ?? step.focusIds).flatMap(resolve) }))
    : nodes.map((node, index) => ({ id: `${prefix}-step-${index}`, title: node.label, body: node.detail, focusElementIds: resolve(node.id), revealElementIds: resolve(node.id) }))
  ).map((step) => ({ ...step, cameraBounds: cameraFor(step.focusElementIds) }));
  return steps.length ? { type: "set_explanation_sequence", sequence: { id: `${prefix}-sequence`, title: input.title ?? "Guided explanation", steps } } : null;
}

export interface ComposedVisual { operations: CanvasOperation[]; repairs: Repair[] }

/**
 * Lay the visual out, then repair it: the human never sees a composed board with text spilling out
 * of its box or two cards on top of each other, whatever the composer or the input did.
 */
export function composeVisualDetailed(input: VisualCompositionInput): ComposedVisual {
  const prefix = cleanId(input.id ?? `visual-${crypto.randomUUID()}`);
  const { operations, repairs } = repairComposition(layoutVisual(input, prefix));
  if (input.kind === "visual_explainer" || input.kind === "guided_explainer") {
    const sequence = explanationSequence(input, prefix, operations);
    if (sequence) operations.push(sequence);
  }
  return { operations, repairs };
}

export function composeVisual(input: VisualCompositionInput): CanvasOperation[] {
  return composeVisualDetailed(input).operations;
}
