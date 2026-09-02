import { TEXT_LINE_HEIGHT, TextMetricsInput, textFontString, wrapTextLines } from "../src/rendering";

export interface TextBlock extends TextMetricsInput { text: string; width: number }
export interface TextMeasurement { height: number; lines: string[]; lineCount: number; longestLine: number; longestWord: number }

let sharedContext: CanvasRenderingContext2D | null | undefined;

/** One offscreen 2D context, reused for every measurement; null when there is no DOM (tests, export scripts). */
function measuringContext(): CanvasRenderingContext2D | null {
  if (sharedContext !== undefined) return sharedContext;
  try { sharedContext = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d"); }
  catch { sharedContext = null; }
  return sharedContext;
}

/**
 * Measures a text block exactly the way the renderer paints it: same font string, same wrapping,
 * same line height. Falls back to a character-width approximation without a DOM.
 */
export function measureTextBlock(block: TextBlock): TextMeasurement {
  const context = measuringContext();
  let measure: (line: string) => number;
  if (context) { context.font = textFontString(block); measure = (line) => context.measureText(line).width; }
  else measure = (line) => line.length * block.fontSize * 0.56;
  const lines = wrapTextLines(block.text, block.width, block.blockStyle, measure);
  const longestLine = lines.reduce((widest, line) => Math.max(widest, measure(line)), 0);
  // A single long word cannot wrap, so a box narrower than this will always spill.
  const longestWord = block.text.split(/\s+/).filter(Boolean).reduce((widest, word) => Math.max(widest, measure(word)), 0);
  return { height: Math.max(block.fontSize * 1.2, lines.length * block.fontSize * TEXT_LINE_HEIGHT), lines, lineCount: lines.length, longestLine, longestWord };
}

export function measuredTextHeight(block: TextBlock): number { return measureTextBlock(block).height; }
