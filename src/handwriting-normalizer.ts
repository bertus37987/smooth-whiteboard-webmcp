import { HandwritingProfile, Paper, StrokeElement, paperBaselineStep } from "./document";
import { InkPoint } from "./strokes";

export interface NormalizationResult {
  strokes: StrokeElement[];
  profile: HandwritingProfile;
  changed: boolean;
  baseline: number;
}

function bounds(strokes: StrokeElement[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const points = strokes.flatMap((stroke) => stroke.points);
  return points.reduce((box, point) => ({
    minX: Math.min(box.minX, point.x),
    minY: Math.min(box.minY, point.y),
    maxX: Math.max(box.maxX, point.x),
    maxY: Math.max(box.maxY, point.y)
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function strokeBounds(stroke: StrokeElement): { minX: number; minY: number; maxX: number; maxY: number } {
  return bounds([stroke]);
}

function pointDistance(left: InkPoint, right: InkPoint): number {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function regularizeLetterStroke(stroke: StrokeElement, targetHeight: number): StrokeElement {
  if (stroke.points.length < 3) return stroke;
  const box = strokeBounds(stroke);
  const width = box.maxX - box.minX; const height = box.maxY - box.minY;
  const diagonal = Math.hypot(width, height);
  const pathLength = stroke.points.slice(1).reduce((total, point, index) => total + pointDistance(stroke.points[index], point), 0);
  const chord = pointDistance(stroke.points[0], stroke.points[stroke.points.length - 1]);

  // Long, narrow and already nearly linear pen strokes are intentional stems
  // (for example i, l, h, t). Remove sideways wobble without changing their
  // endpoints, pressure or writing direction.
  if (height >= targetHeight * 0.48 && width <= Math.max(4, height * 0.24) && chord > 0 && pathLength / chord < 1.24) {
    const centerX = median(stroke.points.map((point) => point.x));
    return { ...stroke, points: stroke.points.map((point) => ({ ...point, x: point.x * 0.22 + centerX * 0.78 })) };
  }

  // A closed, letter-sized loop is most commonly o/0 or the bowl of another
  // letter. Preserve its personal contour, but correct strong oval squeezing
  // and close the tiny capture gap at the pen lift.
  const closure = pointDistance(stroke.points[0], stroke.points[stroke.points.length - 1]);
  if (width >= targetHeight * 0.28 && height >= targetHeight * 0.38 && diagonal > 0 && closure <= diagonal * 0.3) {
    const centerX = (box.minX + box.maxX) / 2; const centerY = (box.minY + box.maxY) / 2;
    const radius = Math.sqrt(Math.max(1, width * height)) / 2;
    const targetRx = radius * 1.02; const targetRy = radius / 1.02;
    const corrected = stroke.points.map((point) => {
      const scaledX = centerX + (point.x - centerX) * targetRx / Math.max(1, width / 2);
      const scaledY = centerY + (point.y - centerY) * targetRy / Math.max(1, height / 2);
      const angle = Math.atan2((scaledY - centerY) / targetRy, (scaledX - centerX) / targetRx);
      const ellipseX = centerX + Math.cos(angle) * targetRx;
      const ellipseY = centerY + Math.sin(angle) * targetRy;
      return { ...point, x: point.x * 0.45 + scaledX * 0.25 + ellipseX * 0.3, y: point.y * 0.45 + scaledY * 0.25 + ellipseY * 0.3 };
    });
    corrected[corrected.length - 1] = { ...corrected[0], pressure: corrected[corrected.length - 1].pressure, time: corrected[corrected.length - 1].time };
    return { ...stroke, points: corrected };
  }
  return stroke;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function baselineSamples(strokes: StrokeElement[]): InkPoint[] {
  return strokes
    .filter((stroke) => stroke.points.length > 1)
    .map((stroke) => stroke.points.reduce((lowest, point) => point.y > lowest.y ? point : lowest));
}

function robustSlope(points: InkPoint[]): number {
  if (points.length < 2) return 0;
  const slopes: number[] = [];
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      const dx = points[right].x - points[left].x;
      if (Math.abs(dx) > 12) slopes.push((points[right].y - points[left].y) / dx);
    }
  }
  return Math.max(-0.22, Math.min(0.22, median(slopes)));
}

export function normalizeHandwritingWord(
  source: StrokeElement[],
  profile: HandwritingProfile,
  paper: Paper,
  baselineAnchors: number[] = []
): NormalizationResult {
  if (source.length === 0 || source.every((stroke) => stroke.points.length === 0)) {
    return { strokes: source, profile, changed: false, baseline: 0 };
  }
  const box = bounds(source);
  const rawHeight = box.maxY - box.minY;
  if (!Number.isFinite(rawHeight) || rawHeight < 8 || rawHeight > 240) {
    return { strokes: source, profile, changed: false, baseline: box.maxY };
  }

  const samples = baselineSamples(source);
  const slope = robustSlope(samples);
  const centerX = (box.minX + box.maxX) / 2;
  const leveledBottoms = samples.map((point) => point.y - slope * (point.x - centerX));
  const rawBaseline = leveledBottoms.length > 0 ? median(leveledBottoms) : box.maxY;
  const step = paperBaselineStep(paper);
  // On ruled paper the visible paper, not an old learned profile, defines the
  // writing body. This keeps lowercase handwriting inside one row.
  const learnedTarget = step > 0 ? step * 0.72 : profile.targetHeight;
  const alignedAnchors = baselineAnchors.map((anchor) => step > 0 ? Math.round(anchor / step) * step : anchor);
  const closestAnchor = alignedAnchors
    .filter(Number.isFinite)
    .sort((left, right) => Math.abs(left - rawBaseline) - Math.abs(right - rawBaseline))[0];
  const snappedBaseline = step > 0 ? Math.round(rawBaseline / step) * step : rawBaseline;
  const nearbyAnchor = closestAnchor !== undefined && Math.abs(closestAnchor - rawBaseline) <= Math.max(26, learnedTarget * 0.65);
  const baseline = nearbyAnchor ? closestAnchor : step > 0 ? snappedBaseline : rawBaseline;

  const scale = step > 0
    ? learnedTarget / rawHeight
    : Math.max(0.55, Math.min(1.75, learnedTarget / rawHeight));
  const transformed = source.map((stroke): StrokeElement => ({
    ...stroke,
    points: stroke.points.map((point) => {
      const ownBox = strokeBounds(stroke);
      const ownCenterX = (ownBox.minX + ownBox.maxX) / 2;
      const leveledY = point.y - slope * (point.x - centerX);
      // Scale each pen stroke around its own horizontal centre. Scaling the
      // complete word from its left edge pulled every later letter left and
      // visibly merged otherwise separate characters.
      return { ...point, x: ownCenterX + (point.x - ownCenterX) * scale, y: baseline + (leveledY - rawBaseline) * scale };
    })
  })).map((stroke) => regularizeLetterStroke(stroke, learnedTarget));

  // Keep a stable personal-size prior so one unusually large first word does
  // not determine all following handwriting.
  const sampleWeight = Math.min(32, profile.samples + 8);
  const observedHeight = Math.max(learnedTarget * 0.72, Math.min(learnedTarget * 1.28, rawHeight));
  const nextProfile: HandwritingProfile = step > 0 ? {
    ...profile,
    samples: profile.samples + 1,
    averageSlope: (profile.averageSlope * sampleWeight + slope) / (sampleWeight + 1)
  } : {
    targetHeight: (profile.targetHeight * sampleWeight + observedHeight) / (sampleWeight + 1),
    samples: profile.samples + 1,
    averageSlope: (profile.averageSlope * sampleWeight + slope) / (sampleWeight + 1)
  };
  const geometryChanged = transformed.some((stroke, strokeIndex) => stroke.points.some((point, pointIndex) => {
    const original = source[strokeIndex]?.points[pointIndex];
    return !original || Math.abs(point.x - original.x) > 0.35 || Math.abs(point.y - original.y) > 0.35;
  }));
  const changed = geometryChanged || Math.abs(slope) > 0.008 || Math.abs(scale - 1) > 0.015 || Math.abs(baseline - rawBaseline) > 1;
  return { strokes: transformed, profile: nextProfile, changed, baseline };
}
