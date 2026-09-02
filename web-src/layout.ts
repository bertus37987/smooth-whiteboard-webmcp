import { Bounds, CanvasOperation } from "./model";
import { measureTextBlock } from "./measure";
import { spacing, typeScale } from "./theme";

/**
 * The lane engine behind the sequence, board and roadmap shapes: measured columns and rows with a
 * header band, so three different diagrams share one idea of where things sit.
 */
export interface LaneColumn { label: string; width: number }
export interface LaneLayout {
  x: number; y: number;
  headerHeight: number;
  columns: Array<{ label: string; x: number; width: number }>;
  rows: Array<{ y: number; height: number }>;
  width: number;
  height: number;
  cell(column: number, row: number): Bounds;
  columnHeader(column: number): Bounds;
}

export interface LaneLayoutInput {
  x: number; y: number;
  columns: LaneColumn[];
  rowHeights: number[];
  gap?: number;
  headerHeight?: number;
  rowGap?: number;
}

export function laneLayout(input: LaneLayoutInput): LaneLayout {
  const gap = input.gap ?? spacing.md;
  const rowGap = input.rowGap ?? spacing.sm;
  const headerHeight = input.headerHeight ?? 56;
  const columns: LaneLayout["columns"] = [];
  let cursorX = input.x;
  for (const column of input.columns) { columns.push({ label: column.label, x: cursorX, width: column.width }); cursorX += column.width + gap; }
  const rows: LaneLayout["rows"] = [];
  let cursorY = input.y + headerHeight + rowGap;
  for (const height of input.rowHeights) { rows.push({ y: cursorY, height }); cursorY += height + rowGap; }
  const width = columns.length ? columns.at(-1)!.x + columns.at(-1)!.width - input.x : 0;
  const height = (rows.length ? rows.at(-1)!.y + rows.at(-1)!.height : input.y + headerHeight) - input.y;
  return {
    x: input.x, y: input.y, headerHeight, columns, rows, width, height,
    cell(column, row) {
      const target = columns[Math.max(0, Math.min(columns.length - 1, column))];
      const line = rows[Math.max(0, Math.min(rows.length - 1, row))] ?? { y: input.y + headerHeight, height: 0 };
      return { minX: target.x, minY: line.y, maxX: target.x + target.width, maxY: line.y + line.height };
    },
    columnHeader(column) {
      const target = columns[Math.max(0, Math.min(columns.length - 1, column))];
      return { minX: target.x, minY: input.y, maxX: target.x + target.width, maxY: input.y + headerHeight };
    }
  };
}

/** Width a lane header needs for its own title, so a column is never narrower than its name. */
export function headerWidth(label: string, minimum = 180): number {
  const measured = measureTextBlock({ text: label, width: 10000, fontSize: typeScale.subheading.fontSize, fontWeight: typeScale.subheading.fontWeight, fontFamily: "handwriting" });
  return Math.max(minimum, Math.ceil(measured.longestLine + spacing.lg * 2));
}

/**
 * Move a whole composed batch. Everything a composer emits carries geometry somewhere different —
 * x/y, from/to, points, camera bounds — so placement has one place that knows about all of it.
 */
export function translateComposition(operations: CanvasOperation[], dx: number, dy: number): CanvasOperation[] {
  if (dx === 0 && dy === 0) return operations;
  const shiftBounds = (bounds: Bounds): Bounds => ({ minX: bounds.minX + dx, minY: bounds.minY + dy, maxX: bounds.maxX + dx, maxY: bounds.maxY + dy });
  return operations.map((operation) => {
    const moved = { ...operation } as CanvasOperation & { x?: number; y?: number; points?: Array<{ x: number; y: number }>; from?: { x: number; y: number }; to?: { x: number; y: number } };
    if (typeof moved.x === "number") moved.x += dx;
    if (typeof moved.y === "number") moved.y += dy;
    if (moved.from) moved.from = { ...moved.from, x: moved.from.x + dx, y: moved.from.y + dy };
    if (moved.to) moved.to = { ...moved.to, x: moved.to.x + dx, y: moved.to.y + dy };
    if (Array.isArray(moved.points)) moved.points = moved.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }));
    if (moved.type === "set_explanation_sequence") {
      moved.sequence = { ...moved.sequence, steps: moved.sequence.steps.map((step) => ({ ...step, cameraBounds: step.cameraBounds ? shiftBounds(step.cameraBounds) : undefined })) };
    }
    return moved as CanvasOperation;
  });
}

/** Bounds a composed batch will occupy, used to drop it into free space. */
export function compositionBounds(operations: CanvasOperation[]): Bounds | null {
  let box: Bounds | null = null;
  const include = (minX: number, minY: number, maxX: number, maxY: number): void => {
    box = box ? { minX: Math.min(box.minX, minX), minY: Math.min(box.minY, minY), maxX: Math.max(box.maxX, maxX), maxY: Math.max(box.maxY, maxY) } : { minX, minY, maxX, maxY };
  };
  for (const operation of operations) {
    const candidate = operation as CanvasOperation & { x?: number; y?: number; width?: number; height?: number; points?: Array<{ x: number; y: number }>; from?: { x: number; y: number }; to?: { x: number; y: number } };
    if (typeof candidate.x === "number" && typeof candidate.y === "number") include(candidate.x, candidate.y, candidate.x + (candidate.width ?? 0), candidate.y + (candidate.height ?? 0));
    for (const point of candidate.points ?? []) include(point.x, point.y, point.x, point.y);
    for (const point of [candidate.from, candidate.to]) if (point) include(point.x, point.y, point.x, point.y);
  }
  return box;
}
