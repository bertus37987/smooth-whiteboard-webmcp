import { PageElement, elementBounds } from "../src/document";
import { Bounds, boardBounds, boundsIntersect } from "./model";

/**
 * A block of the board that is taken. Elements that belong together — a card and its label, an
 * artboard and everything on it — form one unit, because that is what has to be avoided or moved.
 */
export interface OccupiedUnit { id: string; ids: string[]; bounds: Bounds; role: string; label: string | null }

/** Grid step for the free-space search: fine enough to be useful, coarse enough to stay cheap. */
const CELL = 40;
const MAX_CELLS = 120;
/** Breathing room between anything the agent places and anything already there. */
export const PLACEMENT_MARGIN = 64;

const pad = (bounds: Bounds, amount: number): Bounds => ({ minX: bounds.minX - amount, minY: bounds.minY - amount, maxX: bounds.maxX + amount, maxY: bounds.maxY + amount });
const area = (bounds: Bounds): number => Math.max(0, bounds.maxX - bounds.minX) * Math.max(0, bounds.maxY - bounds.minY);
const round = (value: number): number => Math.round(value);
const encloses = (outer: Bounds, inner: Bounds): boolean => outer.minX <= inner.minX && outer.minY <= inner.minY && outer.maxX >= inner.maxX && outer.maxY >= inner.maxY;
const distance = (region: Bounds, x: number, y: number): number => Math.hypot((region.minX + region.maxX) / 2 - x, (region.minY + region.maxY) / 2 - y);

/**
 * The unit an element belongs to: an explicit group wins, otherwise the outermost container it sits
 * in, otherwise the element itself.
 */
function unitKey(element: PageElement, elements: PageElement[], groupOf?: (id: string) => string | null, transparent?: Set<string>): string {
  const group = groupOf?.(element.id);
  if (group) return `group:${group}`;
  let root = element; const seen = new Set<string>([element.id]);
  while (root.parentId && !transparent?.has(root.parentId)) {
    const parent = elements.find((candidate) => candidate.id === root.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id); root = parent;
  }
  return root.id;
}

/**
 * Occupied units on the board. `transparentIds` names containers that should not swallow what they
 * hold — used when asking what a new box would hit, where the things inside a frame matter more
 * than the frame.
 */
export function occupancyMap(elements: PageElement[], groupOf?: (id: string) => string | null, transparentIds?: string[], absorbContained = false): OccupiedUnit[] {
  const transparent = transparentIds?.length ? new Set(transparentIds) : undefined;
  const units = new Map<string, PageElement[]>();
  for (const element of elements) {
    const key = unitKey(element, elements, groupOf, transparent);
    units.set(key, [...(units.get(key) ?? []), element]);
  }
  const mapped = [...units.entries()].map(([key, members]) => {
    const bounds = boardBounds(members) ?? elementBounds(members[0]);
    const anchor = members.find((element) => element.id === key.replace(/^group:/, "")) ?? members[0];
    const label = members.find((element) => element.type === "text" && element.text.trim().length > 0);
    return {
      id: key, ids: members.map((element) => element.id),
      bounds: { minX: round(bounds.minX), minY: round(bounds.minY), maxX: round(bounds.maxX), maxY: round(bounds.maxY) },
      role: anchor.semanticRole ?? anchor.type,
      label: label && label.type === "text" ? label.text.trim().slice(0, 60) : anchor.name?.slice(0, 60) ?? null
    };
  }).sort((left, right) => left.bounds.minY - right.bounds.minY || left.bounds.minX - right.bounds.minX);
  if (!absorbContained) return mapped;
  // A frame and everything laid out inside it is one block to place around, not fifteen.
  const swallowed = new Set<string>();
  for (const unit of mapped) for (const other of mapped) {
    if (unit.id === other.id || swallowed.has(other.id)) continue;
    if (encloses(other.bounds, unit.bounds) && area(other.bounds) > area(unit.bounds)) { swallowed.add(unit.id); break; }
  }
  return mapped.filter((unit) => !swallowed.has(unit.id));
}

/** The area the search runs over: everything drawn so far plus room around it, and the viewport. */
function searchArea(elements: PageElement[], viewport?: Bounds): Bounds {
  const content = boardBounds(elements);
  if (!content) return viewport ?? { minX: -600, minY: -400, maxX: 600, maxY: 400 };
  const width = content.maxX - content.minX; const height = content.maxY - content.minY;
  const grown = pad(content, Math.max(240, Math.min(1600, Math.max(width, height) * .55)));
  if (!viewport) return grown;
  return { minX: Math.min(grown.minX, viewport.minX), minY: Math.min(grown.minY, viewport.minY), maxX: Math.max(grown.maxX, viewport.maxX), maxY: Math.max(grown.maxY, viewport.maxY) };
}

/**
 * The largest empty rectangles on the board, biggest first. Occupied units are rasterised onto a
 * grid and the biggest all-free rectangle is taken repeatedly, masking out each one it finds, so the
 * answer is a handful of genuinely distinct places rather than a thousand overlapping ones.
 */
export function freeRegions(elements: PageElement[], viewport?: Bounds, limit = 4): Bounds[] {
  const search = searchArea(elements, viewport);
  const cols = Math.max(1, Math.min(MAX_CELLS, Math.ceil((search.maxX - search.minX) / CELL)));
  const rows = Math.max(1, Math.min(MAX_CELLS, Math.ceil((search.maxY - search.minY) / CELL)));
  const cellWidth = (search.maxX - search.minX) / cols; const cellHeight = (search.maxY - search.minY) / rows;
  const blocked = occupancyMap(elements).map((unit) => pad(unit.bounds, PLACEMENT_MARGIN / 2));
  const free: boolean[][] = [];
  for (let row = 0; row < rows; row += 1) {
    free[row] = [];
    for (let col = 0; col < cols; col += 1) {
      const cell = { minX: search.minX + col * cellWidth, minY: search.minY + row * cellHeight, maxX: search.minX + (col + 1) * cellWidth, maxY: search.minY + (row + 1) * cellHeight };
      free[row][col] = !blocked.some((box) => boundsIntersect(box, cell));
    }
  }

  const regions: Bounds[] = [];
  for (let pass = 0; pass < limit; pass += 1) {
    const best = largestRectangle(free, cols, rows);
    if (!best || best.width < 2 || best.height < 2) break;
    for (let row = best.row; row < best.row + best.height; row += 1) for (let col = best.col; col < best.col + best.width; col += 1) free[row][col] = false;
    regions.push({
      minX: round(search.minX + best.col * cellWidth), minY: round(search.minY + best.row * cellHeight),
      maxX: round(search.minX + (best.col + best.width) * cellWidth), maxY: round(search.minY + (best.row + best.height) * cellHeight)
    });
  }
  return regions.sort((left, right) => area(right) - area(left));
}

/** Largest all-free rectangle in the grid, by the usual per-row histogram scan. */
function largestRectangle(free: boolean[][], cols: number, rows: number): { row: number; col: number; width: number; height: number } | null {
  const heights = new Array<number>(cols).fill(0);
  let best: { row: number; col: number; width: number; height: number } | null = null;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) heights[col] = free[row][col] ? heights[col] + 1 : 0;
    const stack: number[] = [];
    for (let col = 0; col <= cols; col += 1) {
      const height = col === cols ? 0 : heights[col];
      while (stack.length && heights[stack[stack.length - 1]] >= height) {
        const top = stack.pop()!;
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const candidate = { row: row - heights[top] + 1, col: left, width: col - left, height: heights[top] };
        if (candidate.width > 0 && candidate.height > 0 && (!best || candidate.width * candidate.height > best.width * best.height)) best = candidate;
      }
      stack.push(col);
    }
  }
  return best;
}

/**
 * Where something of this size can go without landing on existing work. Prefers the free region
 * nearest to what is already there, so a board grows as one piece instead of scattering.
 */
export function placeFor(size: { width: number; height: number }, elements: PageElement[], viewport?: Bounds): { x: number; y: number } {
  const content = boardBounds(elements);
  if (!content) return { x: round(-size.width / 2), y: round(-size.height / 2) };
  const needed = { width: size.width + PLACEMENT_MARGIN, height: size.height + PLACEMENT_MARGIN };
  const centreX = (content.minX + content.maxX) / 2; const centreY = (content.minY + content.maxY) / 2;
  const region = freeRegions(elements, viewport, 6)
    .filter((candidate) => candidate.maxX - candidate.minX >= needed.width && candidate.maxY - candidate.minY >= needed.height)
    .sort((left, right) => distance(left, centreX, centreY) - distance(right, centreX, centreY))[0];
  if (region) {
    // Hug the existing content: line the new block up with it and slide it into the free region,
    // so the board grows as one composition instead of scattering into the corners.
    const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(Math.max(min, max), value));
    const x = clamp(content.minX, region.minX + PLACEMENT_MARGIN / 2, region.maxX - needed.width + PLACEMENT_MARGIN / 2);
    const y = clamp(content.minY, region.minY + PLACEMENT_MARGIN / 2, region.maxY - needed.height + PLACEMENT_MARGIN / 2);
    return { x: round(x), y: round(y) };
  }
  return { x: round(content.minX), y: round(content.maxY + PLACEMENT_MARGIN) };
}

/**
 * Units the given box would land on, so a caller can refuse instead of drawing over someone's work.
 * Straddling something is a collision; sitting entirely inside it, or drawing a frame entirely
 * around it, is a deliberate choice and passes.
 */
export function collisionsWith(box: Bounds, elements: PageElement[], options: { ignoreIds?: string[]; groupOf?: (id: string) => string | null; transparentIds?: string[] } = {}): OccupiedUnit[] {
  const ignore = new Set(options.ignoreIds ?? []);
  return occupancyMap(elements.filter((element) => !ignore.has(element.id)), options.groupOf, options.transparentIds)
    .filter((unit) => boundsIntersect(unit.bounds, box) && !encloses(unit.bounds, box) && !encloses(box, unit.bounds));
}
