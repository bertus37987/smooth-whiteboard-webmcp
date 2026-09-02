/**
 * A small SVG path reader. Language models write good path data, so letting them send `d` directly
 * is the difference between drawing rectangles and drawing a thing. Curves and arcs are sampled into
 * points, because everything on this board is ordinary editable canvas geometry.
 */
export interface PathPoint { x: number; y: number }

const CURVE_SAMPLES = 14;
const ARC_SAMPLES = 24;

const numbers = (chunk: string): number[] => (chunk.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number).filter((value) => Number.isFinite(value));

/** Parses path data into one point list per subpath. Unknown commands are skipped, not fatal. */
export function parseSvgPath(d: string, samples = CURVE_SAMPLES): PathPoint[][] {
  const commands = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g);
  if (!commands) return [];
  const subpaths: PathPoint[][] = [];
  let current: PathPoint[] = [];
  let cursor: PathPoint = { x: 0, y: 0 };
  let start: PathPoint = { x: 0, y: 0 };
  let lastCubic: PathPoint | null = null;
  let lastQuadratic: PathPoint | null = null;

  const push = (point: PathPoint): void => { current.push(point); cursor = point; };
  const flush = (): void => { if (current.length > 1) subpaths.push(current); current = []; };

  for (const command of commands) {
    const letter = command[0];
    const relative = letter === letter.toLowerCase() && letter !== "Z" && letter !== "z";
    const values = numbers(command.slice(1));
    const at = (index: number, axis: "x" | "y"): number => relative ? cursor[axis] + values[index] : values[index];

    if (letter === "M" || letter === "m") {
      flush();
      if (values.length < 2) continue;
      const first = { x: relative ? cursor.x + values[0] : values[0], y: relative ? cursor.y + values[1] : values[1] };
      current = [first]; cursor = first; start = first;
      // Extra coordinate pairs after a moveto are implicit linetos.
      for (let index = 2; index + 1 < values.length; index += 2) push({ x: relative ? cursor.x + values[index] : values[index], y: relative ? cursor.y + values[index + 1] : values[index + 1] });
      lastCubic = lastQuadratic = null;
      continue;
    }
    if (letter === "Z" || letter === "z") { if (current.length) { push({ ...start }); flush(); } lastCubic = lastQuadratic = null; continue; }
    if (!current.length) current = [{ ...cursor }];

    if (letter === "L" || letter === "l") { for (let index = 0; index + 1 < values.length; index += 2) push({ x: at(index, "x"), y: at(index + 1, "y") }); lastCubic = lastQuadratic = null; continue; }
    if (letter === "H" || letter === "h") { for (const value of values) push({ x: relative ? cursor.x + value : value, y: cursor.y }); lastCubic = lastQuadratic = null; continue; }
    if (letter === "V" || letter === "v") { for (const value of values) push({ x: cursor.x, y: relative ? cursor.y + value : value }); lastCubic = lastQuadratic = null; continue; }

    if (letter === "C" || letter === "c") {
      for (let index = 0; index + 5 < values.length; index += 6) {
        const c1 = { x: at(index, "x"), y: at(index + 1, "y") };
        const c2 = { x: at(index + 2, "x"), y: at(index + 3, "y") };
        const end = { x: at(index + 4, "x"), y: at(index + 5, "y") };
        for (const point of cubic(cursor, c1, c2, end, samples)) current.push(point);
        cursor = end; lastCubic = c2; lastQuadratic = null;
      }
      continue;
    }
    if (letter === "S" || letter === "s") {
      for (let index = 0; index + 3 < values.length; index += 4) {
        const c1 = lastCubic ? { x: cursor.x * 2 - lastCubic.x, y: cursor.y * 2 - lastCubic.y } : { ...cursor };
        const c2 = { x: at(index, "x"), y: at(index + 1, "y") };
        const end = { x: at(index + 2, "x"), y: at(index + 3, "y") };
        for (const point of cubic(cursor, c1, c2, end, samples)) current.push(point);
        cursor = end; lastCubic = c2; lastQuadratic = null;
      }
      continue;
    }
    if (letter === "Q" || letter === "q") {
      for (let index = 0; index + 3 < values.length; index += 4) {
        const control = { x: at(index, "x"), y: at(index + 1, "y") };
        const end = { x: at(index + 2, "x"), y: at(index + 3, "y") };
        for (const point of quadratic(cursor, control, end, samples)) current.push(point);
        cursor = end; lastQuadratic = control; lastCubic = null;
      }
      continue;
    }
    if (letter === "T" || letter === "t") {
      for (let index = 0; index + 1 < values.length; index += 2) {
        const control = lastQuadratic ? { x: cursor.x * 2 - lastQuadratic.x, y: cursor.y * 2 - lastQuadratic.y } : { ...cursor };
        const end = { x: at(index, "x"), y: at(index + 1, "y") };
        for (const point of quadratic(cursor, control, end, samples)) current.push(point);
        cursor = end; lastQuadratic = control; lastCubic = null;
      }
      continue;
    }
    if (letter === "A" || letter === "a") {
      for (let index = 0; index + 6 < values.length; index += 7) {
        const end = { x: relative ? cursor.x + values[index + 5] : values[index + 5], y: relative ? cursor.y + values[index + 6] : values[index + 6] };
        for (const point of arc(cursor, values[index], values[index + 1], values[index + 2], values[index + 3] !== 0, values[index + 4] !== 0, end)) current.push(point);
        cursor = end; lastCubic = lastQuadratic = null;
      }
      continue;
    }
  }
  flush();
  return subpaths;
}

function cubic(from: PathPoint, c1: PathPoint, c2: PathPoint, to: PathPoint, samples: number): PathPoint[] {
  return Array.from({ length: samples }, (_, index) => {
    const t = (index + 1) / samples; const inverse = 1 - t;
    return {
      x: inverse ** 3 * from.x + 3 * inverse ** 2 * t * c1.x + 3 * inverse * t ** 2 * c2.x + t ** 3 * to.x,
      y: inverse ** 3 * from.y + 3 * inverse ** 2 * t * c1.y + 3 * inverse * t ** 2 * c2.y + t ** 3 * to.y
    };
  });
}

function quadratic(from: PathPoint, control: PathPoint, to: PathPoint, samples: number): PathPoint[] {
  return Array.from({ length: samples }, (_, index) => {
    const t = (index + 1) / samples; const inverse = 1 - t;
    return { x: inverse ** 2 * from.x + 2 * inverse * t * control.x + t ** 2 * to.x, y: inverse ** 2 * from.y + 2 * inverse * t * control.y + t ** 2 * to.y };
  });
}

/** Endpoint-to-centre arc conversion, straight out of the SVG implementation notes. */
function arc(from: PathPoint, rx: number, ry: number, rotation: number, largeArc: boolean, sweep: boolean, to: PathPoint): PathPoint[] {
  if (!rx || !ry) return [to];
  const angle = rotation * Math.PI / 180; const cos = Math.cos(angle); const sin = Math.sin(angle);
  const dx = (from.x - to.x) / 2; const dy = (from.y - to.y) / 2;
  const x1 = cos * dx + sin * dy; const y1 = -sin * dx + cos * dy;
  let radiusX = Math.abs(rx); let radiusY = Math.abs(ry);
  const excess = x1 ** 2 / radiusX ** 2 + y1 ** 2 / radiusY ** 2;
  if (excess > 1) { radiusX *= Math.sqrt(excess); radiusY *= Math.sqrt(excess); }
  const denominator = radiusX ** 2 * y1 ** 2 + radiusY ** 2 * x1 ** 2;
  const factor = Math.sqrt(Math.max(0, (radiusX ** 2 * radiusY ** 2 - denominator) / denominator)) * (largeArc === sweep ? -1 : 1);
  const cx1 = factor * radiusX * y1 / radiusY; const cy1 = -factor * radiusY * x1 / radiusX;
  const cx = cos * cx1 - sin * cy1 + (from.x + to.x) / 2; const cy = sin * cx1 + cos * cy1 + (from.y + to.y) / 2;
  const angleOf = (x: number, y: number): number => Math.atan2((y - cy1) / radiusY, (x - cx1) / radiusX);
  const startAngle = angleOf(x1, y1);
  let delta = angleOf(-x1, -y1) - startAngle;
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;
  return Array.from({ length: ARC_SAMPLES }, (_, index) => {
    const theta = startAngle + delta * (index + 1) / ARC_SAMPLES;
    const px = radiusX * Math.cos(theta); const py = radiusY * Math.sin(theta);
    return { x: cos * px - sin * py + cx, y: sin * px + cos * py + cy };
  });
}

/**
 * Scales subpaths into a world-space box, keeping the aspect ratio and centring what is left over.
 * Path data is usually authored in its own little coordinate system, so this is what makes it land
 * where the agent wanted it.
 */
export function fitSubpaths(subpaths: PathPoint[][], box: { x: number; y: number; width?: number; height?: number }): PathPoint[][] {
  const all = subpaths.flat();
  if (!all.length) return subpaths;
  const minX = Math.min(...all.map((point) => point.x)); const maxX = Math.max(...all.map((point) => point.x));
  const minY = Math.min(...all.map((point) => point.y)); const maxY = Math.max(...all.map((point) => point.y));
  const sourceWidth = Math.max(1e-6, maxX - minX); const sourceHeight = Math.max(1e-6, maxY - minY);
  const targetWidth = box.width ?? sourceWidth; const targetHeight = box.height ?? sourceHeight;
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const offsetX = box.x + (targetWidth - sourceWidth * scale) / 2;
  const offsetY = box.y + (targetHeight - sourceHeight * scale) / 2;
  return subpaths.map((points) => points.map((point) => ({ x: offsetX + (point.x - minX) * scale, y: offsetY + (point.y - minY) * scale })));
}
