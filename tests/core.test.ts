import assert from "node:assert/strict";
import { HighlightElement, ImageElement, ShapeElement, TextElement, createDocument, elementBounds, mergeClosedLineShapes, parseDocument } from "../src/document";
import { buildImagePdf, buildMultiPageImagePdf, dataUrlBytes } from "../src/export";
import { normalizeHandwritingWord } from "../src/handwriting-normalizer";
import { draggedShapePoints, optimizeShape, shapeContainsPoint } from "../src/shapes";
import { snapHighlightToWords, wordBoxes } from "../src/smart-highlight";
import { InkPoint, InkStroke, beautifyStroke, modelCapturedStroke, pressureWidth, visibleInkColor } from "../src/strokes";
import { connectionPoints, estimateTextHeight, isCanvasOperation, lassoElements, migrateBoard, operationElement, scaleElement, translateElement } from "../web-src/model";
import { BoardStore } from "../web-src/store";
import { composeVisual, isVisualComposition } from "../web-src/compositions";
import { registerWhiteboardTools } from "../web-src/webmcp";

const point = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });
const stroke = (points: InkPoint[]): InkStroke => ({ id: "stroke", color: "#111", size: 4, points });

const legacy = {
  version: 1,
  width: 900,
  height: 450,
  paper: "grid",
  strokes: [stroke([point(1, 2), point(3, 4)])],
  texts: [{ id: "t", x: 10, baseline: 40, width: 80, fontSize: 30, color: "#111", text: "Alt" }]
};
const migrated = parseDocument(legacy);
assert.ok(migrated?.migrated);
assert.equal(migrated.document.pages.length, 1);
assert.equal(migrated.document.pages[0].width, 900);
assert.equal(migrated.document.pages[0].height, 1273, "legacy pages extend to DIN A4 without scaling their content");
assert.deepEqual(migrated.document.pages[0].elements.map((element) => element.type), ["stroke", "text"]);

const fresh = createDocument("grid");
assert.equal(fresh.version, 3);
assert.equal(fresh.pages[0].width, 1200);
assert.equal(fresh.pages[0].height, 1697);
const importedImage: ImageElement = { type: "image", id: "image", x: 12, y: 34, width: 500, height: 700, dataUrl: "data:image/png;base64,AA==", mimeType: "image/png" };
assert.deepEqual(elementBounds(importedImage), { minX: 12, minY: 34, maxX: 512, maxY: 734 });

const onePixelJpeg = dataUrlBytes("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==");
const exportedPdf = buildImagePdf(onePixelJpeg, 1, 1);
const exportedPdfText = new TextDecoder().decode(exportedPdf);
assert.ok(exportedPdfText.startsWith("%PDF-1.4"));
assert.ok(exportedPdfText.includes("/DCTDecode"));
assert.ok(exportedPdfText.endsWith("%%EOF\n"));
const multiPdfText = new TextDecoder().decode(buildMultiPageImagePdf([
  { jpeg: onePixelJpeg, pixelWidth: 1, pixelHeight: 1 },
  { jpeg: onePixelJpeg, pixelWidth: 1, pixelHeight: 1 }
]));
assert.ok(multiPdfText.includes("/Count 2"), "multi-page export writes every handwriting page");

const rough = [point(0, 0), point(3, 2), point(6, -2), point(9, 0)];
const smooth = beautifyStroke(rough, 0.65);
assert.equal(smooth[0].x, rough[0].x);
assert.equal(smooth.at(-1)?.x, rough.at(-1)?.x);
const modeled = modelCapturedStroke([point(0, 0), point(3, 4), point(7, 3), point(12, 8), point(18, 7)], true);
assert.ok(modeled.length >= 3, "Google ink modeler produces a usable modeled path");
assert.equal(modeled[0].x, 0, "modeled stroke retains its start point");
assert.ok(Math.hypot((modeled.at(-1)?.x ?? 0) - 18, (modeled.at(-1)?.y ?? 0) - 7) <= 1.5, "modeled stroke catches up to its pen-up endpoint");
assert.ok(modeled.every((candidate) => Number.isFinite(candidate.x) && Number.isFinite(candidate.y) && candidate.pressure > 0));

const webText = operationElement({ type: "create_text", id: "web-text", x: 20, y: 30, text: "Editable", fontSize: 24 });
translateElement(webText, 40, 10);
const movedWebText = elementBounds(webText);
assert.deepEqual([movedWebText.minX, movedWebText.minY, movedWebText.maxY], [60, 40, 69.28], "web elements retain the existing shared geometry model while moving");
assert.ok(Math.abs(movedWebText.maxX - 171.36) < 0.001);
const beforeScale = elementBounds(webText);
scaleElement(webText, beforeScale, { minX: 0, minY: 0, maxX: 222.72, maxY: 57.6 });
assert.equal(Math.round(webText.type === "text" ? webText.fontSize : 0), 48, "agent-created text remains resizable by the human selection tool");
const lassoTarget = operationElement({ type: "create_shape", id: "lasso-target", kind: "rectangle", x: 100, y: 100, width: 80, height: 60 });
assert.deepEqual(lassoElements([lassoTarget], [point(80, 80), point(200, 80), point(200, 180), point(80, 180)]), ["lasso-target"], "lasso selects ordinary shared canvas objects");
assert.deepEqual(lassoElements([lassoTarget], [point(95, 90), point(105, 90), point(105, 170), point(95, 170)]), ["lasso-target"], "lasso catches a crossed edge even when it misses the object centre");
const connectedTarget = operationElement({ type: "create_shape", id: "connected-target", kind: "rectangle", x: 300, y: 100, width: 80, height: 60 });
const connected = connectionPoints(lassoTarget, connectedTarget);
assert.deepEqual([connected.from.x, connected.to.x], [180, 300], "agent connections terminate at object edges instead of crossing their centres");
assert.ok(estimateTextHeight("eine längere mehrzeilige Textbox", 120, 24) > 24 * 1.2, "custom text boxes derive multiple visual lines from their width");
assert.equal(isCanvasOperation({ type: "connect", fromId: "a", toId: "b" }), true);
assert.equal(isCanvasOperation({ type: "translate", ids: ["a"], dx: Number.NaN, dy: 2 }), false, "invalid agent geometry is rejected before it reaches the board");
assert.equal(isCanvasOperation({ type: "create_text", x: 0, y: 0, text: "Titel", fontFamily: "serif", fontWeight: 700, textAlign: "center" }), true, "agent text exposes curated typography without arbitrary font loading");
assert.equal(isCanvasOperation({ type: "create_arrow", from: point(0, 0), to: point(100, 0), arrowHeads: "both", lineStyle: "dashed" }), true, "agent arrows support direction and line styling");
assert.equal(isCanvasOperation({ type: "update_style", ids: ["title"], fontFamily: "comic-sans" }), false, "unsupported font roles are rejected at the WebMCP boundary");

const storedBoards = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storedBoards.get(key) ?? null,
  setItem: (key: string, value: string) => storedBoards.set(key, value)
} });
const connectedStore = new BoardStore();
connectedStore.document.turn = { id: "ink-turn", status: "queued", submittedRevision: 0, selectionIds: [], createdAt: new Date(0).toISOString(), instructionInk: [[point(10, 10), point(40, 40)]], priorityRegions: [], changedElementIds: [] };
assert.equal(connectedStore.document.elements.length, 0, "AI-Pen ink is request context and never a permanent canvas element");
connectedStore.acceptAgentContribution();
assert.deepEqual(connectedStore.document.turn?.instructionInk, [], "accepting an agent contribution clears the transient AI-Pen overlay");
const migratedWebBoard = migrateBoard({ version: 1, revision: 2, elements: [], agentElementIds: [], request: { id: "old", instruction: "old", selectionIds: [], createdAt: new Date(0).toISOString(), state: "ready", ink: [] } });
assert.equal(migratedWebBoard?.version, 2, "legacy web boards migrate to the turn-based document format");
assert.equal(migratedWebBoard?.turn?.status, "queued");
connectedStore.applyOperation({ type: "create_shape", id: "source", kind: "rectangle", x: 0, y: 0, width: 100, height: 80 }, "agent");
connectedStore.applyOperation({ type: "create_shape", id: "target", kind: "ellipse", x: 300, y: 0, width: 100, height: 80 }, "agent");
connectedStore.applyOperation({ type: "connect", id: "link", fromId: "source", toId: "target", label: "dynamic" }, "agent");
connectedStore.changed();
const initialLink = connectedStore.document.elements.find((element) => element.id === "link");
assert.equal(initialLink?.type === "shape" ? initialLink.points[0].x : -1, 100);
connectedStore.applyOperation({ type: "translate", ids: ["source"], dx: 50, dy: 40 }, "human");
connectedStore.changed();
const movedLink = connectedStore.document.elements.find((element) => element.id === "link");
assert.equal(movedLink?.type === "shape" ? movedLink.points[0].x : -1, 150, "smart connector follows a moved endpoint and remains attached to its edge");
connectedStore.applyOperation({ type: "delete", ids: ["target"] }, "human");
connectedStore.changed();
assert.equal(connectedStore.document.elements.some((element) => element.id === "link"), false, "deleting a connected node removes its dangling connector");
assert.equal(connectedStore.document.agentElementIds.includes("link"), false, "removed connector no longer appears in the agent contribution metadata");

const styledText = connectedStore.applyOperation({ type: "create_text", id: "styled", x: 20, y: 160, width: 260, text: "Important", fontFamily: "serif", fontWeight: 700, fontStyle: "italic", textAlign: "center", color: "#2457e6" }, "agent");
assert.deepEqual(styledText, ["styled"]);
connectedStore.applyOperation({ type: "highlight_text", ids: ["styled"], color: "#ffd84d", opacity: 0.22, padding: 8 }, "agent");
const styled = connectedStore.document.elements.find((element) => element.id === "styled");
const styledHighlightIndex = connectedStore.document.elements.findIndex((element) => element.type === "highlight");
assert.equal(styled?.type === "text" ? `${styled.fontFamily}/${styled.fontWeight}/${styled.fontStyle}/${styled.textAlign}` : "", "serif/700/italic/center", "agent typography stays editable as text metadata");
assert.ok(styledHighlightIndex >= 0 && styledHighlightIndex < connectedStore.document.elements.findIndex((element) => element.id === "styled"), "agent text marking is a separate editable highlight layered behind the text");
const noteIds = connectedStore.applyOperation({ type: "create_note", id: "study", x: 0, y: 260, text: "Key idea", blockStyle: "bullet", renderStyle: "sketch" }, "agent");
assert.equal(noteIds.length, 2, "high-level notes compile to editable grouped elements");
const tableIds = connectedStore.applyOperation({ type: "create_table", id: "facts", x: 0, y: 500, width: 360, height: 180, rows: 3, columns: 2, headers: ["Term", "Meaning"], cells: ["", "", "A", "B", "C", "D"] }, "agent");
assert.ok(tableIds.length >= 8, "agent tables compile to ordinary cells and text");
assert.equal(isCanvasOperation({ type: "set_locked", ids: noteIds, locked: true }), true);

const flowVisual = { kind: "flowchart" as const, id: "flow", title: "Ablauf", nodes: [
  { id: "start", label: "Start", role: "primary" as const }, { id: "check", label: "Prüfen", role: "decision" as const }, { id: "done", label: "Fertig" }
], edges: [{ fromId: "start", toId: "check" }, { fromId: "check", toId: "done", label: "ja" }] };
assert.equal(isVisualComposition(flowVisual), true);
const flowOperations = composeVisual(flowVisual);
assert.ok(flowOperations.length >= 11 && flowOperations.every(isCanvasOperation), "flowchart composer emits only ordinary validated canvas operations");
assert.ok(flowOperations.some((operation) => operation.type === "group") && flowOperations.some((operation) => operation.type === "connect"), "flowchart nodes stay editable as groups with smart connectors");
const plotOperations = composeVisual({ kind: "plot", id: "plot", title: "f(x)", axes: { xMin: -2, xMax: 2, yMin: -1, yMax: 4 }, series: [{ label: "x²", points: [{ x: -2, y: 4 }, { x: 0, y: 0 }, { x: 2, y: 4 }] }] });
assert.ok(plotOperations.every(isCanvasOperation) && plotOperations.some((operation) => operation.type === "create_stroke" && operation.id?.includes("series")), "plot composer creates editable graph strokes");
const visualFixtures = [
  { kind: "mindmap" as const, id: "mind", title: "Thema", nodes: [{ id: "root", label: "Kern" }, { id: "branch", label: "Ast", parentId: "root" }] },
  { kind: "ui_wireframe" as const, id: "ui", title: "App", nodes: [{ id: "nav", label: "Navigation", role: "sidebar" as const }, { id: "cta", label: "Weiter", role: "button" as const }] },
  { kind: "research_report" as const, id: "report", title: "Ergebnis", sections: [{ heading: "These", body: "Kurze Evidenz" }, { heading: "Fazit", body: "Nächster Schritt" }] },
  { kind: "study_note" as const, id: "notes", title: "Biology", sections: [{ heading: "Cell", body: "Membrane\nNucleus" }] },
  { kind: "timeline" as const, id: "history", title: "History", nodes: [{ id: "a", label: "1900" }, { id: "b", label: "1950" }] },
  { kind: "comparison" as const, id: "compare", sections: [{ heading: "A", body: "Fast" }, { heading: "B", body: "Clear" }] },
  { kind: "visual_explainer" as const, id: "explain", nodes: [{ id: "one", label: "Cause", detail: "Input" }, { id: "two", label: "Effect", detail: "Output" }] }
];
for (const fixture of visualFixtures) { const operations = composeVisual(fixture); assert.ok(operations.length > 2 && operations.length <= 240 && operations.every(isCanvasOperation), `${fixture.kind} composer stays inside the progressive editable operation contract`); }

storedBoards.clear(); const groupedStore = new BoardStore();
for (const operation of composeVisual({ kind: "math_steps", id: "math", steps: [{ expression: "2x = 8" }, { expression: "x = 4", explanation: "durch 2 teilen" }] })) groupedStore.applyOperation(operation, "agent");
groupedStore.changed(); const groupedShape = groupedStore.document.elements.find((element) => element.id === "math-step-0"); const groupedLabel = groupedStore.document.elements.find((element) => element.id === "math-step-0-label");
const shapeBefore = groupedShape ? elementBounds(groupedShape) : null; const labelBefore = groupedLabel ? elementBounds(groupedLabel) : null;
groupedStore.applyOperation({ type: "translate", ids: ["math-step-0"], dx: 50, dy: 25 }, "human"); groupedStore.changed();
assert.equal(groupedShape && shapeBefore ? elementBounds(groupedShape).minX - shapeBefore.minX : 0, 50);
assert.equal(groupedLabel && labelBefore ? elementBounds(groupedLabel).minX - labelBefore.minX : 0, 50, "moving a composed node keeps its text attached through grouping");
assert.equal(isCanvasOperation({ type: "align", ids: ["a", "b"], alignment: "left" }), true);
assert.equal(isCanvasOperation({ type: "distribute", ids: ["a", "b", "c"], axis: "horizontal", gap: 24 }), true);
assert.equal(isCanvasOperation({ type: "create_polygon", id: "custom", closed: true, points: [point(0, 0), point(80, 0), point(40, 60)] }), true, "agent can create arbitrary editable vector drawings");
assert.equal(isCanvasOperation({ type: "update_points", id: "custom", points: [point(0, 0), point(90, 10)] }), true, "agent can refine an existing custom path instead of replacing it");

storedBoards.clear(); const layoutStore = new BoardStore();
layoutStore.applyOperation({ type: "create_shape", id: "left", kind: "rectangle", x: 0, y: 40, width: 40, height: 30 }, "agent");
layoutStore.applyOperation({ type: "create_shape", id: "middle", kind: "rectangle", x: 100, y: 80, width: 40, height: 30 }, "agent");
layoutStore.applyOperation({ type: "create_shape", id: "right", kind: "rectangle", x: 260, y: 120, width: 40, height: 30 }, "agent");
layoutStore.applyOperation({ type: "align", ids: ["left", "middle", "right"], alignment: "top" }, "agent");
assert.deepEqual(["left", "middle", "right"].map((id) => elementBounds(layoutStore.document.elements.find((element) => element.id === id)!).minY), [40, 40, 40], "agent alignment acts on live editable objects");
layoutStore.applyOperation({ type: "distribute", ids: ["left", "middle", "right"], axis: "horizontal", gap: 30 }, "agent");
const layoutBoxes = ["left", "middle", "right"].map((id) => elementBounds(layoutStore.document.elements.find((element) => element.id === id)!));
assert.deepEqual([layoutBoxes[1].minX - layoutBoxes[0].maxX, layoutBoxes[2].minX - layoutBoxes[1].maxX], [30, 30], "agent can create exact equal spacing for UI proposals");

assert.equal(optimizeShape(stroke([point(0, 1), point(30, -1), point(60, 2), point(100, 0)])).kind, "line");
assert.equal(optimizeShape(stroke(modelCapturedStroke([point(0, 1), point(30, -1), point(60, 2), point(100, 0)], true))).kind, "line", "ink modeling keeps an intentional straight-line gesture recognizable");
assert.equal(optimizeShape(stroke([point(0, 0), point(20, 1), point(40, 0), point(60, 1)])).kind, null, "short handwriting strokes must not become shapes");

const arrowGesture = stroke([
  point(0, 80), point(30, 80), point(60, 80), point(100, 80),
  point(135, 80), point(110, 60), point(135, 80), point(110, 100)
]);
assert.equal(optimizeShape(arrowGesture).kind, "arrow");
const ellipsePoints: InkPoint[] = [];
for (let index = 0; index <= 48; index += 1) {
  const angle = index / 48 * Math.PI * 2;
  ellipsePoints.push(point(100 + 60 * Math.cos(angle), 80 + 35 * Math.sin(angle)));
}
assert.equal(optimizeShape(stroke(ellipsePoints)).kind, "ellipse");

const rectanglePoints: InkPoint[] = [];
for (let x = 0; x <= 100; x += 10) rectanglePoints.push(point(x, 0));
for (let y = 10; y <= 60; y += 10) rectanglePoints.push(point(100, y));
for (let x = 90; x >= 0; x -= 10) rectanglePoints.push(point(x, 60));
for (let y = 50; y >= 0; y -= 10) rectanglePoints.push(point(0, y));
assert.equal(optimizeShape(stroke(rectanglePoints)).kind, "rectangle");
assert.equal(optimizeShape(stroke(rectanglePoints)).stroke.points.length, 5, "rectangle stays an exact sharp polygon");

const trianglePoints = [
  ...Array.from({ length: 11 }, (_, index) => point(index * 6, 80 - index * 8)),
  ...Array.from({ length: 11 }, (_, index) => point(60 + index * 6, index * 8)),
  ...Array.from({ length: 21 }, (_, index) => point(120 - index * 6, 80))
];
assert.equal(optimizeShape(stroke(trianglePoints)).kind, "polygon");
assert.equal(draggedShapePoints("triangle", point(10, 10), point(110, 90)).length, 3);
assert.equal(draggedShapePoints("diamond", point(10, 10), point(110, 90)).length, 4);
const draggedCircle = draggedShapePoints("circle", point(10, 10), point(90, 50));
assert.equal(Math.abs(draggedCircle[1].x - draggedCircle[0].x), Math.abs(draggedCircle[1].y - draggedCircle[0].y), "circle drag always creates an equal-sided box");
const fillableTriangle: ShapeElement = { type: "shape", id: "fill", kind: "polygon", points: draggedShapePoints("triangle", point(10, 10), point(110, 90)), color: "#111", size: 3, closed: true };
assert.equal(shapeContainsPoint(fillableTriangle, point(60, 55)), true, "fill tool can hit the inside of a closed dragged shape");
assert.equal(shapeContainsPoint(fillableTriangle, point(5, 5)), false);
const fillableEllipse: ShapeElement = { ...fillableTriangle, kind: "ellipse", points: [point(10, 10), point(110, 90)] };
assert.equal(shapeContainsPoint(fillableEllipse, point(60, 50)), true);

const pressureStroke = { ...stroke([point(0, 0), point(10, 0)]), size: 10, pressureSensitivity: 1 };
pressureStroke.points[0].pressure = 0.1;
pressureStroke.points[1].pressure = 0.9;
assert.ok(pressureWidth(pressureStroke, pressureStroke.points[1]) > pressureWidth(pressureStroke, pressureStroke.points[0]));
assert.equal(visibleInkColor("#dadada"), "#202124", "legacy dark-theme ink must remain visible on white paper");
assert.equal(visibleInkColor("#2457e6"), "#2457e6");

const slopedWord = [
  { ...stroke([point(20, 70), point(25, 35), point(30, 72)]), type: "stroke" as const, id: "a" },
  { ...stroke([point(60, 78), point(65, 40), point(70, 80)]), type: "stroke" as const, id: "b" }
];
const normalized = normalizeHandwritingWord(slopedWord, { targetHeight: 48, samples: 8, averageSlope: 0 }, "blank");
const firstBottom = Math.max(...normalized.strokes[0].points.map((candidate) => candidate.y));
const secondBottom = Math.max(...normalized.strokes[1].points.map((candidate) => candidate.y));
assert.ok(Math.abs(firstBottom - secondBottom) < 2, "word strokes should share one baseline");
assert.ok(normalized.profile.samples === 9);

const nextWord = [
  { ...stroke([point(120, 77), point(125, 38), point(130, 79)]), type: "stroke" as const, id: "next" }
];
const sameRow = normalizeHandwritingWord(nextWord, normalized.profile, "blank", [normalized.baseline]);
assert.equal(sameRow.baseline, normalized.baseline, "nearby words must share the learned page baseline");
assert.equal(Math.max(...sameRow.strokes[0].points.map((candidate) => candidate.y)), normalized.baseline);

const tallWord = [{ ...stroke([point(0, 140), point(10, 40), point(20, 140)]), type: "stroke" as const, id: "tall" }];
const shortWord = [{ ...stroke([point(40, 140), point(50, 110), point(60, 140)]), type: "stroke" as const, id: "short" }];
const stableProfile = { targetHeight: 52, samples: 0, averageSlope: 0 };
const normalizedTall = normalizeHandwritingWord(tallWord, stableProfile, "blank");
const normalizedShort = normalizeHandwritingWord(shortWord, stableProfile, "blank");
const resultHeight = (word: typeof normalizedTall.strokes): number => Math.max(...word.flatMap((item) => item.points.map((candidate) => candidate.y))) - Math.min(...word.flatMap((item) => item.points.map((candidate) => candidate.y)));
assert.ok(Math.abs(resultHeight(normalizedTall.strokes) - resultHeight(normalizedShort.strokes)) < 18, "very different input sizes converge toward one handwriting size");

const gridWord = [{ ...stroke([point(10, 50), point(15, 20), point(20, 51)]), type: "stroke" as const, id: "grid" }];
const normalizedGrid = normalizeHandwritingWord(gridWord, { targetHeight: 80, samples: 12, averageSlope: 0 }, "grid");
assert.equal(normalizedGrid.baseline, 48, "grid baselines use the visible 24-unit grid");
assert.ok(Math.abs(resultHeight(normalizedGrid.strokes) - 24 * 0.72) < 0.01, "grid writing height is derived from the visible grid rather than an old profile");
const lineWord = [{ ...stroke([point(10, 89), point(15, 20), point(20, 90)]), type: "stroke" as const, id: "line" }];
const normalizedLine = normalizeHandwritingWord(lineWord, { targetHeight: 96, samples: 20, averageSlope: 0 }, "lines");
assert.equal(normalizedLine.baseline, 96, "lined writing always lands exactly on a visible 32-unit line");
assert.ok(Math.abs(resultHeight(normalizedLine.strokes) - 32 * 0.72) < 0.01, "lined writing body fits inside one paper row");
assert.equal(normalizedLine.profile.targetHeight, 96, "ruled paper does not overwrite the personal blank-paper profile");

const proportionalStroke = [{ ...stroke([point(0, 100), point(0, 20), point(50, 100)]), type: "stroke" as const, id: "proportional" }];
const proportional = normalizeHandwritingWord(proportionalStroke, { targetHeight: 90, samples: 2, averageSlope: 0 }, "lines");
const boxRatio = (word: typeof proportional.strokes): number => {
  const points = word.flatMap((item) => item.points); const width = Math.max(...points.map((candidate) => candidate.x)) - Math.min(...points.map((candidate) => candidate.x));
  const height = Math.max(...points.map((candidate) => candidate.y)) - Math.min(...points.map((candidate) => candidate.y)); return width / height;
};
assert.ok(Math.abs(boxRatio(proportional.strokes) - boxRatio(proportionalStroke)) < 0.02, "paper sizing scales width and height together instead of squeezing letters");
const separatedLetters = [
  { ...stroke([point(20, 100), point(20, 20)]), type: "stroke" as const, id: "left-letter" },
  { ...stroke([point(120, 100), point(120, 20)]), type: "stroke" as const, id: "right-letter" }
];
const separatedResult = normalizeHandwritingWord(separatedLetters, { targetHeight: 50, samples: 1, averageSlope: 0 }, "lines").strokes;
const centre = (candidate: typeof separatedResult[number]): number => {
  const xs = candidate.points.map((item) => item.x); return (Math.min(...xs) + Math.max(...xs)) / 2;
};
assert.ok(Math.abs((centre(separatedResult[1]) - centre(separatedResult[0])) - 100) < 0.01, "size correction must not pull separate letters together");

const wobblyStem = [{ ...stroke([point(50, 100), point(54, 82), point(47, 63), point(53, 41), point(49, 20)]), type: "stroke" as const, id: "stem" }];
const straightStem = normalizeHandwritingWord(wobblyStem, { targetHeight: 52, samples: 1, averageSlope: 0 }, "lines").strokes[0];
const stemWidth = (candidate: typeof straightStem): number => Math.max(...candidate.points.map((item) => item.x)) - Math.min(...candidate.points.map((item) => item.x));
assert.ok(stemWidth(straightStem) < stemWidth(wobblyStem[0]) * 0.45, "long h/i/l stems are straightened without replacing the stroke");

const squashedLoopPoints = Array.from({ length: 25 }, (_, index) => {
  const angle = index / 24 * Math.PI * 2; return point(100 + Math.cos(angle) * 22, 80 + Math.sin(angle) * 42);
});
squashedLoopPoints[squashedLoopPoints.length - 1] = point(102, 81);
const squashedLoop = [{ ...stroke(squashedLoopPoints), type: "stroke" as const, id: "loop" }];
const roundedLoop = normalizeHandwritingWord(squashedLoop, { targetHeight: 52, samples: 1, averageSlope: 0 }, "lines").strokes[0];
assert.ok(Math.abs(boxRatio([roundedLoop]) - 1) < Math.abs(boxRatio(squashedLoop) - 1), "closed o/0 loops become rounder instead of vertically squeezed");
assert.deepEqual([roundedLoop.points.at(-1)?.x, roundedLoop.points.at(-1)?.y], [roundedLoop.points[0].x, roundedLoop.points[0].y], "small o/0 pen-lift gaps are closed");

const v2 = { version: 2, pages: fresh.pages };
const migratedV2 = parseDocument(v2);
assert.ok(migratedV2?.migrated);
assert.equal(migratedV2.document.version, 3);

const polygonPage = createDocument("blank").pages[0];
const lineShape = (id: string, from: InkPoint, to: InkPoint): ShapeElement => ({
  type: "shape", id, kind: "line", points: [from, to], color: "#111", size: 4, closed: false
});
polygonPage.elements = [
  lineShape("l1", point(100, 100), point(300, 100)),
  lineShape("l2", point(303, 102), point(300, 260)),
  lineShape("l3", point(300, 260), point(100, 260)),
  lineShape("l4", point(98, 258), point(101, 102))
];
assert.ok(mergeClosedLineShapes(polygonPage, "#7c5cff", 0.25));
assert.equal(polygonPage.elements.length, 1);
assert.equal(polygonPage.elements[0].type, "shape");
if (polygonPage.elements[0].type === "shape") {
  assert.equal(polygonPage.elements[0].kind, "polygon");
  assert.equal(polygonPage.elements[0].points.length, 4);
  assert.equal(polygonPage.elements[0].fillOpacity, 0.25);
}

const openPage = createDocument("blank").pages[0];
openPage.elements = [
  lineShape("o1", point(0, 0), point(100, 0)),
  lineShape("o2", point(100, 0), point(180, 80)),
  lineShape("o3", point(180, 80), point(260, 20))
];
assert.equal(mergeClosedLineShapes(openPage), false, "open connected lines must stay separate");
assert.equal(openPage.elements.length, 3);

const words: TextElement[] = [
  { type: "text", id: "one", x: 20, baseline: 80, width: 80, fontSize: 40, color: "#111", text: "eins" },
  { type: "text", id: "two", x: 130, baseline: 80, width: 90, fontSize: 40, color: "#111", text: "zwei" },
  { type: "text", id: "three", x: 260, baseline: 80, width: 80, fontSize: 40, color: "#111", text: "drei" }
];
fresh.pages[0].elements = words;
const marker = (x1: number, x2: number): HighlightElement => ({
  type: "highlight", id: "h", x1, x2, y: 65, size: 34, color: "#ffd84d", opacity: 0.28
});
assert.deepEqual([snapHighlightToWords(fresh.pages[0], marker(35, 80))!.x1, snapHighlightToWords(fresh.pages[0], marker(35, 80))!.x2], [12, 108]);
assert.deepEqual([snapHighlightToWords(fresh.pages[0], marker(35, 180))!.x1, snapHighlightToWords(fresh.pages[0], marker(35, 180))!.x2], [12, 228]);
assert.deepEqual([snapHighlightToWords(fresh.pages[0], marker(35, 310))!.x1, snapHighlightToWords(fresh.pages[0], marker(35, 310))!.x2], [12, 348]);
assert.equal(snapHighlightToWords(fresh.pages[0], { ...marker(360, 430), y: 300 }), null, "empty marker gestures are discarded");

const rawWords = createDocument("blank").pages[0];
rawWords.elements = [
  { ...stroke([point(20, 50), point(35, 80)]), type: "stroke", id: "rw1" },
  { ...stroke([point(48, 52), point(65, 80)]), type: "stroke", id: "rw2" },
  { ...stroke([point(122, 50), point(140, 80)]), type: "stroke", id: "rw3" },
  { ...stroke([point(152, 52), point(170, 80)]), type: "stroke", id: "rw4" }
];
assert.equal(wordBoxes(rawWords).length, 2, "large pen gaps must split raw handwriting into separate words");
const snappedRaw = snapHighlightToWords(rawWords, marker(25, 62));
assert.deepEqual([snappedRaw!.x1, snappedRaw!.x2], [12, 73], "raw-word marker must not expand across the next word");

const twoRows = createDocument("lines").pages[0];
twoRows.elements = [
  { type: "text", id: "top", x: 20, baseline: 80, width: 80, fontSize: 38, color: "#111", text: "oben" },
  { type: "text", id: "bottom", x: 20, baseline: 150, width: 100, fontSize: 38, color: "#111", text: "unten" }
];
const lowerGesture = [point(28, 142), point(70, 146), point(105, 143)];
const snappedLower = snapHighlightToWords(twoRows, { ...marker(28, 105), y: 143 }, lowerGesture);
assert.deepEqual([snappedLower!.x1, snappedLower!.x2], [12, 128], "pen marker selects only the touched writing row");
assert.ok(snappedLower!.y > 115, "marker stays on the lower row instead of jumping upward");

void (async () => {
  const registered: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: { modelContext: { registerTool: (tool: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => { registered.push(tool); } } } });
  const available = await registerWhiteboardTools({ session: () => ({}), waitForTurn: async () => ({}), inspect: () => ({}), focus: () => ({}), publishPlan: () => ({}), apply: async () => ({}), compose: async () => ({}), complete: () => ({}) }, new AbortController().signal);
  assert.equal(available, true); assert.deepEqual(registered.map((tool) => tool.name), ["start_whiteboard_session", "wait_for_human_turn", "inspect_whiteboard", "focus_whiteboard_region", "publish_agent_plan", "apply_whiteboard_changes", "create_structured_visual", "complete_whiteboard_contribution"]);
  const visualTool = registered.find((tool) => tool.name === "create_structured_visual");
  assert.ok(JSON.stringify(visualTool?.inputSchema).includes("ui_wireframe") && JSON.stringify(visualTool?.inputSchema).includes("study_note"), "WebMCP advertises high-level UI, learning and diagram capabilities");
  const inspectTool = registered.find((tool) => tool.name === "inspect_whiteboard"); const applyTool = registered.find((tool) => tool.name === "apply_whiteboard_changes"); const applySchema = JSON.stringify(applyTool?.inputSchema);
  assert.ok(inspectTool?.description?.includes("AI pen") && applySchema.includes("highlight_text") && applySchema.includes("fontFamily") && applySchema.includes("arrowHeads") && applySchema.includes("create_table"), "WebMCP exposes spatial ink context, typography, tables, text marking and richer arrows to the agent");
  console.log("core tests: ok");
})().catch((error) => { console.error(error); process.exitCode = 1; });
