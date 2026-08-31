// The pinned package intentionally ships TypeScript source. Loading it through
// the bundler keeps our stricter project typecheck from re-checking upstream's
// internal unused imports while the public surface remains typed here.
interface InkModelResult { position: { x: number; y: number }; time: number; pressure: number }
interface InkStatus { ok: boolean }
interface InkModelerInstance {
  reset(params: InkModelParams): InkStatus;
  update(input: { eventType: string; position: { x: number; y: number }; time: number; pressure: number }, results: InkModelResult[]): InkStatus;
  predict(results: InkModelResult[]): InkStatus;
}
interface InkModelParams { predictionParams: { kind: "stroke_end" | "disabled" } }
const inkModeler = require("ink-stroke-modeler-ts") as {
  EventType: { Down: string; Move: string; Up: string };
  StrokeModeler: new () => InkModelerInstance;
  defaultStrokeModelParams: () => InkModelParams;
};
const { EventType, StrokeModeler, defaultStrokeModelParams } = inkModeler;

export interface InkPoint {
  x: number;
  y: number;
  pressure: number;
  /** DOMHighResTimeStamp in milliseconds when available. */
  time?: number;
}

export interface InkStroke {
  id: string;
  color: string;
  size: number;
  pressureSensitivity?: number;
  points: InkPoint[];
}

function distance(a: InkPoint, b: InkPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Resample uneven pointer events before smoothing so fast and slow strokes behave alike. */
export function resample(points: InkPoint[], spacing = 3): InkPoint[] {
  if (points.length < 2) return [...points];

  const output: InkPoint[] = [{ ...points[0] }];
  let previous = { ...points[0] };
  let carry = 0;

  for (let index = 1; index < points.length; index += 1) {
    const target = points[index];
    let segment = distance(previous, target);
    if (segment < 0.01) continue;

    while (carry + segment >= spacing) {
      const ratio = (spacing - carry) / segment;
      previous = {
        x: previous.x + (target.x - previous.x) * ratio,
        y: previous.y + (target.y - previous.y) * ratio,
        pressure: previous.pressure + (target.pressure - previous.pressure) * ratio,
        time: previous.time !== undefined && target.time !== undefined ? previous.time + (target.time - previous.time) * ratio : undefined
      };
      output.push({ ...previous });
      segment = distance(previous, target);
      carry = 0;
    }

    carry += segment;
    previous = { ...target };
  }

  const last = points[points.length - 1];
  if (distance(output[output.length - 1], last) > 0.001) output.push({ ...last });
  else output[output.length - 1] = { ...last };
  return output;
}

/**
 * CPU-only real-time ink modeling based on Google's Ink Stroke Modeler.
 * Coordinates are normalized so the upstream unit-agnostic defaults behave
 * consistently on all page sizes. It preserves pressure and never sends data
 * off-device.
 */
export function modelCapturedStroke(points: InkPoint[], finished = true): InkPoint[] {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  const sampled = resample(points, 2.4);
  const modeler = new StrokeModeler();
  const params = defaultStrokeModelParams();
  params.predictionParams = finished ? { kind: "stroke_end" } : params.predictionParams;
  const reset = modeler.reset(params);
  if (!reset.ok) return cleanCapturedStrokeLegacy(sampled);

  const modeled: InkModelResult[] = [];
  let syntheticTime = 0;
  const firstTime = sampled[0].time;
  for (let index = 0; index < sampled.length; index += 1) {
    const point = sampled[index];
    if (index > 0) {
      const previous = sampled[index - 1];
      const measured = firstTime !== undefined && point.time !== undefined ? (point.time - firstTime) / 1000 : NaN;
      if (Number.isFinite(measured) && measured > syntheticTime) syntheticTime = measured;
      else syntheticTime += Math.max(1 / 240, Math.min(1 / 30, distance(previous, point) / 500));
    }
    const eventType = index === 0 ? EventType.Down : finished && index === sampled.length - 1 ? EventType.Up : EventType.Move;
    const status = modeler.update({ eventType, position: { x: point.x / 1000, y: point.y / 1000 }, time: syntheticTime, pressure: point.pressure }, modeled);
    if (!status.ok) return cleanCapturedStrokeLegacy(sampled);
  }
  if (!finished) {
    const prediction: InkModelResult[] = [];
    if (modeler.predict(prediction).ok) modeled.push(...prediction);
  }
  const output = modeled.map((result): InkPoint => ({
    x: result.position.x * 1000,
    y: result.position.y * 1000,
    pressure: Math.max(0.05, Math.min(1, result.pressure)),
    time: firstTime === undefined ? undefined : firstTime + result.time * 1000
  }));
  if (output.length === 0) return cleanCapturedStrokeLegacy(sampled);
  output[0] = { ...sampled[0] };
  if (finished && distance(output[output.length - 1], sampled[sampled.length - 1]) > 1.5) output.push({ ...sampled[sampled.length - 1] });
  // The model outputs at least 180 samples per second. Re-spacing its already
  // smooth curve prevents a slowly held 20 px stem from storing hundreds of
  // visually redundant points.
  return resample(output, 0.8);
}

/** Removes capture jitter while preserving endpoints and the writer's characteristic shape. */
export function beautifyStroke(points: InkPoint[], strength: number): InkPoint[] {
  if (points.length < 3 || strength <= 0) return points.map((point) => ({ ...point }));
  let result = resample(points);
  const mix = Math.min(0.32, Math.max(0, strength) * 0.32);
  const passes = strength > 0.72 ? 3 : strength > 0.35 ? 2 : 1;

  for (let pass = 0; pass < passes; pass += 1) {
    const next = result.map((point) => ({ ...point }));
    for (let index = 1; index < result.length - 1; index += 1) {
      const before = result[index - 1];
      const current = result[index];
      const after = result[index + 1];
      next[index] = {
        x: current.x * (1 - mix * 2) + (before.x + after.x) * mix,
        y: current.y * (1 - mix * 2) + (before.y + after.y) * mix,
        pressure: current.pressure * 0.6 + (before.pressure + after.pressure) * 0.2
      };
    }
    result = next;
  }
  return result;
}

/**
 * Lightly regularises pointer-event spacing without averaging away the writer's
 * characteristic loops, corners or stroke direction.
 */
function cleanCapturedStrokeLegacy(points: InkPoint[]): InkPoint[] {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  const sampled = resample(points, 2.4);
  let result = sampled.map((point) => ({ ...point }));
  for (let pass = 0; pass < 2; pass += 1) {
    const next = result.map((point) => ({ ...point }));
    for (let index = 1; index < result.length - 1; index += 1) {
      const before = result[index - 1];
      const point = result[index];
      const after = result[index + 1];
      const incoming = { x: point.x - before.x, y: point.y - before.y };
      const outgoing = { x: after.x - point.x, y: after.y - point.y };
      const lengths = Math.hypot(incoming.x, incoming.y) * Math.hypot(outgoing.x, outgoing.y);
      const cosine = lengths > 0 ? (incoming.x * outgoing.x + incoming.y * outgoing.y) / lengths : 1;
      // Smooth calm sections strongly, but retain intentional loops and corners.
      const mix = cosine > 0.78 ? 0.18 : cosine > 0.25 ? 0.11 : 0.045;
      next[index] = {
        x: point.x * (1 - mix * 2) + (before.x + after.x) * mix,
        y: point.y * (1 - mix * 2) + (before.y + after.y) * mix,
        pressure: Math.max(0.05, Math.min(1, point.pressure * 0.72 + (before.pressure + after.pressure) * 0.14))
      };
    }
    result = next;
  }
  return result;
}

export function cleanCapturedStroke(points: InkPoint[], finished = false): InkPoint[] {
  return modelCapturedStroke(points, finished);
}

export function pressureWidth(stroke: InkStroke, point: InkPoint): number {
  const sensitivity = Math.max(0, Math.min(1, stroke.pressureSensitivity ?? 0));
  const pressure = Math.max(0.05, Math.min(1, point.pressure || 0.5));
  return stroke.size * ((1 - sensitivity) + sensitivity * (0.32 + pressure * 1.15));
}

/** Makes legacy theme-derived light gray ink readable on the white paper. */
export function visibleInkColor(color: string): string {
  const match = color.trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return color;
  const value = Number.parseInt(match[1], 16);
  const red = (value >> 16 & 255) / 255;
  const green = (value >> 8 & 255) / 255;
  const blue = (value & 255) / 255;
  const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  return chroma < 0.09 && luminance > 0.72 ? "#202124" : color;
}

export function strokeTouches(stroke: InkStroke, point: InkPoint, radius: number): boolean {
  return stroke.points.some((candidate) => distance(candidate, point) <= radius + stroke.size / 2);
}
