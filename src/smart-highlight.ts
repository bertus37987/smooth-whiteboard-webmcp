import { HandwritingPage, HighlightElement, StrokeElement, TextElement, elementBounds, paperBaselineStep } from "./document";
import { InkPoint } from "./strokes";

export interface WordBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function mergeRawStrokeBoxes(page: HandwritingPage): WordBox[] {
  const step = paperBaselineStep(page.paper);
  const boxes = page.elements
    .filter((element): element is StrokeElement => element.type === "stroke")
    .map((element) => elementBounds(element))
    .filter((box) => {
      const width = box.maxX - box.minX; const height = box.maxY - box.minY;
      // Ignore old freehand shapes and long divider lines. They are ink, but
      // not words the smart marker should ever snap to.
      return height <= (step > 0 ? step * 2.4 : 120) && !(width > page.width * 0.45 && height < 10);
    });
  if (boxes.length < 2) return boxes;

  const parents = boxes.map((_, index) => index);
  const root = (index: number): number => {
    let cursor = index;
    while (parents[cursor] !== cursor) cursor = parents[cursor];
    while (parents[index] !== index) { const next = parents[index]; parents[index] = cursor; index = next; }
    return cursor;
  };
  const join = (left: number, right: number): void => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const a = boxes[left];
      const b = boxes[right];
      const horizontalGap = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
      if (horizontalGap > 34) continue;
      const verticalGap = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
      const bottomDifference = Math.abs(a.maxY - b.maxY);
      const aHeight = a.maxY - a.minY;
      const bHeight = b.maxY - b.minY;
      const smallMark = Math.min(aHeight, bHeight) < 12;
      const sameWritingRow = bottomDifference <= 38 && verticalGap <= 44;
      const attachedDotOrCross = smallMark && horizontalGap <= 12 && verticalGap <= 72;
      if (sameWritingRow || attachedDotOrCross) join(left, right);
    }
  }

  const grouped = new Map<number, WordBox>();
  for (const [index, box] of boxes.entries()) {
    const key = root(index);
    const group = grouped.get(key);
    if (!group) grouped.set(key, { ...box });
    else {
      group.minX = Math.min(group.minX, box.minX);
      group.minY = Math.min(group.minY, box.minY);
      group.maxX = Math.max(group.maxX, box.maxX);
      group.maxY = Math.max(group.maxY, box.maxY);
    }
  }
  return [...grouped.values()].sort((left, right) => left.minY - right.minY || left.minX - right.minX);
}

export function wordBoxes(page: HandwritingPage): WordBox[] {
  const textBoxes = page.elements
    .filter((element): element is TextElement => element.type === "text")
    .map((element) => elementBounds(element));
  return [...textBoxes, ...mergeRawStrokeBoxes(page)];
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length === 0 ? 0 : sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function snapHighlightToWords(page: HandwritingPage, highlight: HighlightElement, gesture: InkPoint[] = []): HighlightElement | null {
  const snapped = { ...highlight };
  const points = gesture.length > 0 ? gesture : [
    { x: snapped.x1, y: snapped.y, pressure: 0.5 },
    { x: snapped.x2, y: snapped.y, pressure: 0.5 }
  ];
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const gestureY = median(points.map((point) => point.y));
  const candidates = wordBoxes(page).filter((box) => box.maxX >= minX - 8 && box.minX <= maxX + 8);
  const rowDistance = (box: WordBox): number => Math.abs((box.minY + box.maxY) / 2 - gestureY);
  const bestDistance = candidates.length > 0 ? Math.min(...candidates.map(rowDistance)) : Infinity;
  const matches = candidates.filter((box) => {
    const height = Math.max(12, box.maxY - box.minY);
    return rowDistance(box) <= bestDistance + Math.min(12, height * 0.28)
      && rowDistance(box) <= Math.max(24, height * 0.72);
  });
  if (matches.length === 0) {
    return null;
  }
  snapped.x1 = Math.min(...matches.map((box) => box.minX)) - 8;
  snapped.x2 = Math.max(...matches.map((box) => box.maxX)) + 8;
  // Place the translucent bar through the body of the written words rather
  // than at the raw pen gesture's potentially slanted position.
  snapped.y = matches.reduce((sum, box) => sum + box.minY + (box.maxY - box.minY) * 0.56, 0) / matches.length;
  const typicalHeight = median(matches.map((box) => box.maxY - box.minY));
  snapped.size = Math.max(12, Math.min(snapped.size, typicalHeight * 0.9));
  return snapped;
}
