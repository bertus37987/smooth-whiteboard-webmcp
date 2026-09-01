import { StrokeElement } from "../src/document";

interface NativeHandwritingStroke {
  addPoint(point: { x: number; y: number; t: number }): void;
}

interface NativeHandwritingDrawing {
  addStroke(stroke: NativeHandwritingStroke): void;
  getPrediction(): Promise<Array<{ text: string }>>;
  clear(): void;
}

interface NativeHandwritingRecognizer {
  startDrawing(hints?: { recognitionType?: "text"; inputType?: "stylus" | "mouse"; alternatives?: number }): NativeHandwritingDrawing;
  finish(): void;
}

type HandwritingWindow = Window & typeof globalThis & {
  HandwritingStroke?: new () => NativeHandwritingStroke;
};

type HandwritingNavigator = Navigator & {
  queryHandwritingRecognizer?: (constraint: { languages: string[] }) => Promise<unknown | null>;
  createHandwritingRecognizer?: (constraint: { languages: string[] }) => Promise<NativeHandwritingRecognizer>;
};

/**
 * Thin, local-only adapter around the browser/OS handwriting recognizer.
 * It never replaces visible ink. The result is metadata for WebMCP inspection.
 */
export class EnglishHandwritingAssist {
  private recognizer: NativeHandwritingRecognizer | null = null;
  private initialization: Promise<boolean> | null = null;

  supported(): boolean {
    const candidate = navigator as HandwritingNavigator;
    return typeof candidate.createHandwritingRecognizer === "function" && typeof (window as HandwritingWindow).HandwritingStroke === "function";
  }

  async initialize(): Promise<boolean> {
    if (this.recognizer) return true;
    if (!this.supported()) return false;
    if (!this.initialization) this.initialization = this.create();
    return this.initialization;
  }

  private async create(): Promise<boolean> {
    const candidate = navigator as HandwritingNavigator;
    try {
      if (candidate.queryHandwritingRecognizer && !await candidate.queryHandwritingRecognizer({ languages: ["en"] })) return false;
      this.recognizer = await candidate.createHandwritingRecognizer!({ languages: ["en"] });
      return true;
    } catch {
      this.recognizer = null;
      return false;
    }
  }

  async recognize(strokes: StrokeElement[]): Promise<string | null> {
    if (!strokes.length || !await this.initialize() || !this.recognizer) return null;
    const StrokeConstructor = (window as HandwritingWindow).HandwritingStroke;
    if (!StrokeConstructor) return null;
    const drawing = this.recognizer.startDrawing({ recognitionType: "text", inputType: "stylus", alternatives: 3 });
    try {
      for (const source of strokes) {
        const nativeStroke = new StrokeConstructor();
        for (const [index, point] of source.points.entries()) nativeStroke.addPoint({ x: point.x, y: point.y, t: point.time ?? index * 8 });
        drawing.addStroke(nativeStroke);
      }
      const prediction = await drawing.getPrediction();
      const text = prediction[0]?.text?.trim();
      return text && /[a-z]/i.test(text) ? text.slice(0, 240) : null;
    } catch {
      return null;
    } finally {
      drawing.clear();
    }
  }

  destroy(): void { this.recognizer?.finish(); this.recognizer = null; this.initialization = null; }
}
