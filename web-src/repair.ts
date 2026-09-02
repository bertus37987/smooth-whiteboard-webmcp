import { Bounds, CanvasOperation, boundsIntersect, boundsOverlapArea, tableCellIds } from "./model";
import { measureTextBlock } from "./measure";
import { spacing } from "./theme";

export type RepairCode = "snapped" | "grew-container" | "widened-ellipse" | "moved-apart" | "grew-frame" | "placed";
export interface Repair { code: RepairCode; elementIds: string[]; action: string }
export interface RepairedComposition { operations: CanvasOperation[]; repairs: Repair[] }

/** Positions and sizes land on this grid, so every gap in a composed visual is a multiple of it. */
const GRID = 4;
const PASSES = 14;
/** Text inside an ellipse only fits the inscribed rectangle, which is 1/sqrt(2) of the box. */
const ELLIPSE_FIT = Math.SQRT1_2;

type Boxed = Extract<CanvasOperation, { type: "create_shape" | "create_note" | "create_frame" | "create_table" | "create_callout" }>;
type Placed = Extract<CanvasOperation, { type: "create_shape" | "create_note" | "create_frame" | "create_table" | "create_callout" | "create_text" }>;

const BOXED = ["create_shape", "create_note", "create_frame", "create_table", "create_callout"];
const isBoxed = (operation: CanvasOperation): operation is Boxed => BOXED.includes(operation.type);
const isPlaced = (operation: CanvasOperation): operation is Placed => isBoxed(operation) || operation.type === "create_text";
// The + 0 keeps -0 out of the geometry, where it would show up as a spurious difference.
const snap = (value: number): number => Math.round(value / GRID) * GRID + 0 || 0;

/** A container is scenery: other content is expected to sit on top of it. */
const isContainer = (operation: CanvasOperation): boolean =>
  operation.type === "create_frame" || (operation.type === "create_shape" && ["artboard", "frame", "screen", "section", "sidebar", "header", "navbar", "modal", "list"].includes(operation.semanticRole ?? ""));

function textHeight(operation: Extract<CanvasOperation, { type: "create_text" }>): number {
  return measureTextBlock({ text: operation.text, width: operation.width ?? 240, fontSize: operation.fontSize ?? 32, fontFamily: operation.fontFamily ?? "handwriting", fontWeight: operation.fontWeight, fontStyle: operation.fontStyle, blockStyle: operation.blockStyle }).height;
}

function operationBounds(operation: Placed): Bounds {
  if (operation.type === "create_text") {
    const width = operation.width ?? 240;
    return { minX: operation.x, minY: operation.y, maxX: operation.x + width, maxY: operation.y + textHeight(operation) };
  }
  if (operation.type === "create_note") return { minX: operation.x, minY: operation.y, maxX: operation.x + (operation.width ?? 320), maxY: operation.y + (operation.height ?? 210) };
  if (operation.type === "create_callout") return { minX: operation.x, minY: operation.y, maxX: operation.x + (operation.width ?? 260), maxY: operation.y + 80 };
  return { minX: operation.x, minY: operation.y, maxX: operation.x + operation.width, maxY: operation.y + operation.height };
}

function move(operation: Placed, dx: number, dy: number): void { operation.x += dx; operation.y += dy; }

/**
 * A unit is what a human sees as one object: a card and its label, a note, a table. Repair moves
 * units, never their halves, so a label can never be left behind by its box.
 */
interface Unit { ids: string[]; members: Placed[]; container: boolean }

function buildUnits(operations: CanvasOperation[]): Unit[] {
  const groupOf = new Map<string, string>();
  for (const operation of operations) {
    if (operation.type === "group" && operation.groupId) for (const id of operation.ids) groupOf.set(id, operation.groupId);
    if (operation.type === "create_note" && operation.id) { groupOf.set(`${operation.id}-card`, operation.id); groupOf.set(`${operation.id}-text`, operation.id); }
    if (operation.type === "create_callout" && operation.id) for (const suffix of ["-box", "-text", "-leader"]) groupOf.set(`${operation.id}${suffix}`, operation.id);
    if (operation.type === "create_frame" && operation.id) for (const suffix of ["-border", "-title"]) groupOf.set(`${operation.id}${suffix}`, operation.id);
    if (operation.type === "create_table" && operation.id) for (const id of tableCellIds(operation, operation.id)) groupOf.set(id, operation.id);
  }
  const units = new Map<string, Unit>();
  for (const operation of operations) {
    if (!isPlaced(operation)) continue;
    const id = operation.id ?? `anonymous-${units.size}`;
    const key = groupOf.get(id) ?? id;
    const unit = units.get(key) ?? { ids: [], members: [], container: false };
    unit.ids.push(id); unit.members.push(operation); unit.container ||= isContainer(operation);
    units.set(key, unit);
  }
  return [...units.values()];
}

const unitBounds = (unit: Unit): Bounds => unit.members.map(operationBounds).reduce((box, next) => ({ minX: Math.min(box.minX, next.minX), minY: Math.min(box.minY, next.minY), maxX: Math.max(box.maxX, next.maxX), maxY: Math.max(box.maxY, next.maxY) }));

/**
 * Deterministic clean-up of composer geometry before it reaches the board: snap to the grid, grow
 * boxes that cannot hold their text, keep ellipse labels inside the curve, push unrelated units
 * apart and keep artboard children inside their frame. Idempotent by construction.
 */
export function repairComposition(operations: CanvasOperation[]): RepairedComposition {
  const repaired = structuredClone(operations);
  const repairs: Repair[] = [];
  const placed = repaired.filter(isPlaced);

  for (const operation of placed) {
    const before = { x: operation.x, y: operation.y };
    operation.x = snap(operation.x); operation.y = snap(operation.y);
    if (isBoxed(operation) && operation.type !== "create_note" && operation.type !== "create_callout") { operation.width = snap(operation.width); operation.height = Math.max(GRID, snap(operation.height)); }
    if (operation.id && (before.x !== operation.x || before.y !== operation.y)) repairs.push({ code: "snapped", elementIds: [operation.id], action: "aligned to the layout grid" });
  }

  // A box has to hold the text that belongs to it, and an ellipse only offers its inscribed rectangle.
  for (const unit of buildUnits(repaired)) {
    const box = unit.members.find((member): member is Boxed => isBoxed(member) && member.type !== "create_table");
    const label = unit.members.find((member): member is Extract<CanvasOperation, { type: "create_text" }> => member.type === "create_text");
    if (!box || !label || box.type === "create_note" || box.type === "create_callout") continue;
    const ellipse = box.type === "create_shape" && box.kind === "ellipse";
    const padding = operationBounds(label).minY - box.y;
    const needed = textHeight(label) + Math.max(GRID, padding) * 2;
    const requiredHeight = snap(ellipse ? needed / ELLIPSE_FIT : needed);
    const requiredWidth = snap(ellipse ? ((label.width ?? 240) + padding * 2) / ELLIPSE_FIT : box.width);
    if (box.type === "create_frame" || box.type === "create_shape") {
      if (requiredHeight > box.height) { box.height = requiredHeight; repairs.push({ code: ellipse ? "widened-ellipse" : "grew-container", elementIds: [box.id ?? ""], action: "made room for its text" }); }
      if (ellipse && requiredWidth > box.width) { box.width = requiredWidth; repairs.push({ code: "widened-ellipse", elementIds: [box.id ?? ""], action: "widened so the label stays inside the curve" }); }
      // Keep the label centred in whatever the box became.
      label.y = snap(box.y + (box.height - textHeight(label)) / 2);
      if (ellipse) label.x = snap(box.x + (box.width - (label.width ?? 240)) / 2);
    }
  }

  // Unrelated units must not sit on top of each other.
  for (let pass = 0; pass < PASSES; pass += 1) {
    const units = buildUnits(repaired).filter((unit) => !unit.container);
    let moved = false;
    for (let left = 0; left < units.length; left += 1) {
      for (let right = left + 1; right < units.length; right += 1) {
        const a = unitBounds(units[left]); const b = unitBounds(units[right]);
        if (!boundsIntersect(a, b) || boundsOverlapArea(a, b) <= 0) continue;
        const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const overlapY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
        const push = snap(Math.min(overlapX, overlapY) + spacing.sm);
        const horizontal = overlapX <= overlapY;
        // Both units give way, so a dense cluster spreads out instead of piling up on one side.
        const half = snap(push / 2) || GRID;
        const forward = horizontal ? b.minX >= a.minX : b.minY >= a.minY;
        const shift = (unit: Unit, direction: number): void => { for (const member of unit.members) move(member, horizontal ? direction * half : 0, horizontal ? 0 : direction * half); };
        shift(units[right], forward ? 1 : -1); shift(units[left], forward ? -1 : 1);
        repairs.push({ code: "moved-apart", elementIds: [...units[left].ids, ...units[right].ids], action: "separated two objects that overlapped" });
        moved = true;
      }
    }
    if (!moved) break;
  }

  // Whatever is parented to a frame stays inside it: the frame grows rather than clipping content.
  for (const frame of repaired.filter((operation): operation is Extract<CanvasOperation, { type: "create_frame" }> => operation.type === "create_frame")) {
    const borderId = `${frame.id}-border`;
    const children = placed.filter((operation) => "parentId" in operation && operation.parentId === borderId);
    if (!children.length) continue;
    const content = children.map(operationBounds).reduce((box, next) => ({ minX: Math.min(box.minX, next.minX), minY: Math.min(box.minY, next.minY), maxX: Math.max(box.maxX, next.maxX), maxY: Math.max(box.maxY, next.maxY) }));
    const margin = spacing.lg;
    const width = Math.max(frame.width, snap(content.maxX - frame.x + margin));
    const height = Math.max(frame.height, snap(content.maxY - frame.y + margin));
    if (width !== frame.width || height !== frame.height) {
      frame.width = width; frame.height = height;
      repairs.push({ code: "grew-frame", elementIds: [frame.id ?? ""], action: "grew so its content stays inside" });
    }
  }

  return { operations: repaired, repairs: repairs.filter((repair) => repair.elementIds.some(Boolean) || repair.code === "placed") };
}
