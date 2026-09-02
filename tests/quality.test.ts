import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { elementBounds } from "../src/document";
import { arrowHeadPoints, textFontFamilies, wrapTextLines } from "../src/rendering";
import { BoardStore } from "../web-src/store";
import { CanvasOperation, lintBoard } from "../web-src/model";
import { VisualCompositionInput, VisualKind, composeVisual, composeVisualDetailed } from "../web-src/compositions";
import { exportPages, makeSvg } from "../web-src/export";
import { measureTextBlock } from "../web-src/measure";
import { repairComposition } from "../web-src/repair";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key)
} });

function boardFrom(operations: CanvasOperation[]): BoardStore {
  storage.clear();
  const store = new BoardStore();
  for (const operation of operations) store.applyOperation(operation, "agent");
  store.changed();
  return store;
}

/* ------------------------- adversarial fixtures ------------------------- */

const LONG = "An unusually long label that keeps going well past the point where any layout would like it to stop, so the composer has to cope with a paragraph where a short caption was expected.";
const kinds: VisualKind[] = ["flowchart", "mindmap", "ui_wireframe", "ui_mockup", "research_report", "math_steps", "plot", "study_note", "timeline", "comparison", "hierarchy", "visual_explainer", "guided_explainer"];

function fixture(kind: VisualKind, index: number): VisualCompositionInput {
  const many = Array.from({ length: 15 }, (_, node) => ({ id: `n${node}`, label: node % 3 === 0 ? LONG : `Node ${node}`, detail: node % 2 === 0 ? LONG : undefined }));
  const sections = Array.from({ length: 6 }, (_, section) => ({ heading: section % 2 === 0 ? LONG : `Heading ${section}`, body: section % 3 === 0 ? "" : LONG }));
  return {
    kind, id: `torture-${index}`, title: LONG,
    width: index % 2 === 0 ? 320 : undefined,
    nodes: many, sections,
    steps: [{ expression: "x^2 + 2x + 1 = 0", explanation: LONG }, { expression: "(x + 1)^2 = 0" }],
    series: [{ label: LONG, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 4 }] }],
    axes: { xMin: 0, xMax: 2, yMin: 0, yMax: 4, xLabel: LONG, yLabel: "y" },
    presentationSteps: [{ title: LONG, body: LONG, focusIds: ["n0"] }, { title: "Second", body: LONG, focusIds: ["n1"] }]
  };
}

async function main(): Promise<void> {
  /* Every composition kind survives adversarial input without a layout defect. */
  for (const [index, kind] of kinds.entries()) {
    const composed = composeVisualDetailed(fixture(kind, index));
    const store = boardFrom(composed.operations);
    const issues = lintBoard(store.document);
    const blocking = issues.filter((issue) => issue.code === "text-overflow" || issue.code === "overlap" || issue.code === "off-artboard");
    assert.deepEqual(blocking.map((issue) => `${issue.code}:${issue.elementIds.join("+")}`), [], `${kind} composes without overflow, overlap or content outside its artboard`);
    assert.ok(store.document.elements.length > 0, `${kind} produces canvas content`);
  }

  /* An empty or minimal input is not a crash either. */
  for (const kind of kinds) {
    const empty = composeVisual({ kind, id: `bare-${kind}` });
    const store = boardFrom(empty);
    assert.deepEqual(lintBoard(store.document).filter((issue) => issue.code === "overlap"), [], `${kind} with no content has nothing to overlap`);
  }

  /* ------------------------------ repair ------------------------------ */

  /* Repair is idempotent: running it again changes nothing. */
  {
    const first = repairComposition(composeVisual(fixture("flowchart", 0)));
    const second = repairComposition(first.operations);
    assert.deepEqual(second.operations, first.operations, "a repaired composition is already stable");
    assert.deepEqual(second.repairs, [], "the second pass finds nothing left to fix");
  }

  /* Overlapping units are pushed apart, and everything lands on the grid. */
  {
    const overlapping: CanvasOperation[] = [
      { type: "create_shape", id: "a", kind: "rectangle", x: 3, y: 7, width: 200, height: 120 },
      { type: "create_shape", id: "b", kind: "rectangle", x: 33, y: 27, width: 200, height: 120 }
    ];
    const { operations, repairs } = repairComposition(overlapping);
    const boxes = operations.filter((operation): operation is Extract<CanvasOperation, { type: "create_shape" }> => operation.type === "create_shape");
    for (const box of boxes) { assert.equal(Math.abs(box.x % 4), 0, "x is on the grid"); assert.equal(Math.abs(box.y % 4), 0, "y is on the grid"); }
    const [a, b] = boxes.map((box) => ({ minX: box.x, minY: box.y, maxX: box.x + box.width, maxY: box.y + box.height }));
    const overlap = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
    assert.equal(overlap, 0, "two unrelated boxes no longer sit on top of each other");
    assert.ok(repairs.some((repair) => repair.code === "moved-apart"), "the repair is reported to the agent");
  }

  /* A label in an ellipse has to fit the inscribed rectangle, not the bounding box. */
  {
    const tight: CanvasOperation[] = [
      { type: "create_shape", id: "bubble", kind: "ellipse", x: 0, y: 0, width: 180, height: 80 },
      { type: "create_text", id: "bubble-label", x: 18, y: 18, width: 144, text: "Condensation of water vapour", fontSize: 20 },
      { type: "group", groupId: "bubble-unit", ids: ["bubble", "bubble-label"] }
    ];
    const { operations } = repairComposition(tight);
    const bubble = operations.find((operation): operation is Extract<CanvasOperation, { type: "create_shape" }> => operation.type === "create_shape")!;
    const label = operations.find((operation): operation is Extract<CanvasOperation, { type: "create_text" }> => operation.type === "create_text")!;
    const height = measureTextBlock({ text: label.text, width: label.width!, fontSize: label.fontSize!, fontFamily: "handwriting" }).height;
    assert.ok(height <= bubble.height * Math.SQRT1_2 + 1, "the text fits the rectangle inscribed in the ellipse");
    assert.ok(label.width! <= bubble.width * Math.SQRT1_2 + 1, "and so does its width");
  }

  /* Guided explanation cameras point at where the notes actually ended up. */
  {
    const composed = composeVisualDetailed({ kind: "guided_explainer", id: "tour", title: "Cell",
      nodes: [{ id: "membrane", label: "Membrane", detail: LONG }, { id: "nucleus", label: "Nucleus", detail: "Holds the DNA." }],
      presentationSteps: [{ title: "Outside", body: "Start here.", focusIds: ["membrane"] }, { title: "Inside", body: "Then here.", focusIds: ["nucleus"] }] });
    const sequence = composed.operations.find((operation): operation is Extract<CanvasOperation, { type: "set_explanation_sequence" }> => operation.type === "set_explanation_sequence")!;
    const notes = new Map(composed.operations.filter((operation): operation is Extract<CanvasOperation, { type: "create_note" }> => operation.type === "create_note").map((note) => [note.id!, note]));
    for (const step of sequence.sequence.steps) {
      const note = notes.get(step.focusElementIds[0].replace(/-card$/, ""))!;
      const camera = step.cameraBounds!;
      assert.ok(camera.minX <= note.x && camera.maxX >= note.x + (note.width ?? 0), `${step.title} frames its note horizontally`);
      assert.ok(camera.minY <= note.y && camera.maxY >= note.y + (note.height ?? 0), `${step.title} frames its note vertically`);
    }
  }

  /* ------------------------- export parity ------------------------- */

  /* The SVG uses the canvas wrapping, its markers and its hanging indent. */
  {
    const store = boardFrom([{ type: "create_text", id: "bullets", x: 0, y: 0, width: 220, fontSize: 20, blockStyle: "bullet", text: "A bullet whose text is long enough to wrap onto a second line\nA second bullet" }]);
    const element = store.document.elements[0];
    assert.ok(element.type === "text");
    const svg = makeSvg(exportPages(store.document)[0]);
    const tspans = [...svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((match) => match[1]);
    if (element.type === "text") {
      const measured = measureTextBlock(element);
      assert.equal(tspans.length, measured.lines.length, "the export wraps exactly like the canvas");
      assert.deepEqual(tspans, measured.lines.map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")), "line for line");
      assert.ok(measured.lines[0].startsWith("• "), "the marker is on the first line");
      assert.ok(measured.lines[1].startsWith("  "), "a wrapped bullet line hangs under the text, not under the bullet");
      assert.ok(measured.lines.at(-1)!.startsWith("• "), "the second paragraph gets its own marker");
    }
    assert.ok(svg.includes('xml:space="preserve"'), "the indent survives XML whitespace collapsing");
  }

  /* Numbered lists count paragraphs, they do not repeat "1.". */
  {
    const lines = wrapTextLines("First step\nSecond step\nThird step", 400, "numbered", (line) => line.length * 8);
    assert.deepEqual(lines, ["1. First step", "2. Second step", "3. Third step"]);
  }

  /* Canvas and SVG draw the same arrow head. */
  {
    const store = boardFrom([{ type: "create_arrow", id: "edge", from: { x: 0, y: 0 }, to: { x: 200, y: 0 }, strokeWidth: 3 }]);
    const arrow = store.document.elements[0];
    assert.ok(arrow.type === "shape");
    const svg = makeSvg(exportPages(store.document)[0]);
    if (arrow.type === "shape") {
      const barbs = arrowHeadPoints(arrow.points[0], arrow.points[1], arrow.size);
      const bounds = elementBounds(arrow);
      const local = (point: { x: number; y: number }): string => `${point.x - bounds.minX},${point.y - bounds.minY}`;
      assert.ok(svg.includes(local(barbs.left)) && svg.includes(local(barbs.right)), "the exported head uses the shared geometry");
      assert.ok(!svg.includes("<polygon points=\"" + local(arrow.points[1])), "the head is stroked like on the canvas, not filled");
    }
  }

  /* ------------------------- bundled fonts ------------------------- */

  {
    const css = readFileSync("web/app.css", "utf8");
    const html = readFileSync("web/index.html", "utf8");
    for (const [family, file] of [["Inter", "web/fonts/inter-latin.woff2"], ["Caveat", "web/fonts/caveat-latin.woff2"]] as const) {
      assert.ok(css.includes(`font-family:"${family}"`), `${family} is declared as a bundled face`);
      assert.ok(statSync(file).size > 10000, `${file} is a real font file`);
      assert.ok(html.includes(file.replace("web/", "./")), `${file} is preloaded`);
    }
    assert.ok(css.includes("font-display:block"), "text never paints in a fallback face first");
    assert.ok(textFontFamilies.sans.startsWith('"Inter"'), "the canvas asks for the bundled sans first");
    assert.ok(textFontFamilies.handwriting.startsWith('"Caveat"'), "the canvas asks for the bundled handwriting face first");
    assert.ok(readFileSync("web-esbuild.mjs", "utf8").includes("web/fonts"), "the build ships the fonts");
    assert.ok(readFileSync("THIRD_PARTY_NOTICES.md", "utf8").includes("Open Font License"), "the fonts are credited");
  }

  /* ------------------------- the human toolbar ------------------------- */

  {
    const html = readFileSync("web/index.html", "utf8");
    for (const tool of ["pen", "ai-pen", "marker", "eraser", "select", "hand", "text", "sticky", "image", "artboard", "ai-lasso"]) {
      assert.ok(html.includes(`data-tool="${tool}"`), `the toolbar offers the ${tool} tool`);
    }
    assert.ok(!html.includes("content-popover") && !html.includes("data-ui-template"), "the component template popover is gone");
    assert.ok(!readFileSync("web/app.css", "utf8").includes("content-popover"), "and so are its styles");
    const app = readFileSync("web-src/app.ts", "utf8");
    assert.ok(!app.includes("insertUiTemplate"), "the template inserter is gone with it");
    assert.ok(app.includes("attachToAgent"), "the AI lasso hands objects to the agent");
    assert.ok(app.includes("textEditorOpen"), "a click that closes the text editor does not open the next one");
  }

  console.log("quality tests: ok");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
