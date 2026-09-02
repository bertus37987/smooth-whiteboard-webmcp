import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { elementBounds } from "../src/document";
import { arrowHeadPoints, textFontFamilies, wrapTextLines } from "../src/rendering";
import { BoardStore } from "../web-src/store";
import { CanvasOperation, boundsOverlapArea, lintBoard } from "../web-src/model";
import { VisualCompositionInput, VisualKind, composeVisual, composeVisualDetailed, splitDetail, visualKinds } from "../web-src/compositions";
import { CollaborationSession } from "../web-src/collaboration";
import { connectionRoute, routeBlocked } from "../web-src/model";
import { exportPages, makeSvg } from "../web-src/export";
import { measureTextBlock } from "../web-src/measure";
import { repairComposition } from "../web-src/repair";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key)
} });

const box = (id: string, x: number, y: number, width = 120, height = 90): CanvasOperation => ({ type: "create_shape", id, kind: "rectangle", x, y, width, height });

function boardFrom(operations: CanvasOperation[]): BoardStore {
  storage.clear();
  const store = new BoardStore();
  for (const operation of operations) store.applyOperation(operation, "agent");
  store.changed();
  return store;
}

/* ------------------------- adversarial fixtures ------------------------- */

const LONG = "An unusually long label that keeps going well past the point where any layout would like it to stop, so the composer has to cope with a paragraph where a short caption was expected.";
const kinds: VisualKind[] = visualKinds;

function fixture(kind: VisualKind, index: number): VisualCompositionInput {
  const many = Array.from({ length: 15 }, (_, node) => ({ id: `n${node}`, label: node % 3 === 0 ? LONG : `Node ${node}`, detail: node % 2 === 0 ? LONG : undefined }));
  const sections = Array.from({ length: 6 }, (_, section) => ({ heading: section % 2 === 0 ? LONG : `Heading ${section}`, body: section % 3 === 0 ? "" : LONG }));
  return {
    kind, id: `torture-${index}`, title: LONG,
    edges: many.slice(1).map((node, edge) => ({ fromId: many[edge].id, toId: node.id, label: edge % 4 === 0 ? LONG : `step ${edge}`, detail: edge % 3 === 0 ? LONG : undefined })),
    columns: Array.from({ length: 5 }, (_, column) => ({ name: column % 2 === 0 ? LONG : `Column ${column}`, cards: Array.from({ length: column === 0 ? 12 : 2 }, (_, card) => ({ label: card % 2 === 0 ? LONG : `Card ${card}`, detail: card === 0 ? LONG : undefined })) })),
    lanes: ["Alpha", LONG, "Gamma"],
    periods: ["W1", "W2", "W3"],
    items: [{ lane: "Alpha", label: LONG, start: 0, span: 3 }, { lane: LONG, label: "Bar", start: 1 }, { lane: "Gamma", label: "Ship", start: 2, milestone: true }, { lane: "Alpha", label: "Out of range", start: 9, span: 4 }],
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

  /* ------------------------ round three shapes ------------------------ */

  /* A sequence reads top to bottom, and its labels never sit on an actor. */
  {
    const composed = composeVisualDetailed({ kind: "sequence", id: "seq", title: "How HTTP works",
      nodes: [{ id: "browser", label: "Browser" }, { id: "server", label: "Server" }],
      edges: [
        { fromId: "browser", toId: "server", label: "GET /index.html", detail: "Method, path and headers." },
        { fromId: "server", toId: "server", label: "route and render" },
        { fromId: "server", toId: "browser", label: "200 OK" }
      ] });
    const store = boardFrom(composed.operations);
    assert.deepEqual(lintBoard(store.document).filter((issue) => issue.code === "overlap" || issue.code === "text-overflow"), [], "a sequence composes clean");
    const messages = [0, 1, 2].map((index) => store.document.elements.find((element) => element.id === `seq-msg-${index}`)!);
    const rows = messages.map((message) => elementBounds(message).minY);
    assert.ok(rows[0] < rows[1] && rows[1] < rows[2], "messages run down the page in the order they were given");
    const actors = ["seq-browser", "seq-server"].map((id) => elementBounds(store.document.elements.find((element) => element.id === id)!));
    for (const index of [0, 1, 2]) {
      const label = elementBounds(store.document.elements.find((element) => element.id === `seq-msg-${index}-label`)!);
      for (const actor of actors) assert.equal(boundsOverlapArea(label, actor), 0, `message ${index} label keeps clear of the actor cards`);
    }
    const sequence = composed.operations.find((operation): operation is Extract<CanvasOperation, { type: "set_explanation_sequence" }> => operation.type === "set_explanation_sequence")!;
    assert.equal(sequence.sequence.steps.length, 3, "every message is a narration step");
    assert.equal(sequence.sequence.steps[0].body, "Method, path and headers.", "edge detail becomes the narration");
    const back = store.document.elements.find((element) => element.id === "seq-msg-2")!;
    assert.ok(back.type === "shape" && back.points[0].x > back.points.at(-1)!.x, "a reply points back the way it came");
  }

  /* Board cards live inside their own column. */
  {
    const composed = composeVisual({ kind: "board", id: "brd", title: "This week", columns: [
      { name: "To do", cards: [{ label: "Roadmap shape" }, { label: "Connector labels", detail: "Off the card edge" }] },
      { name: "Doing", cards: [{ label: "Sequence shape" }] },
      { name: "Done", cards: [{ label: "Fonts" }, { label: "Lasso" }] }
    ] });
    const store = boardFrom(composed);
    assert.deepEqual(lintBoard(store.document).filter((issue) => issue.code === "overlap" || issue.code === "text-overflow"), [], "a board composes clean");
    const columns = [0, 1, 2].map((index) => elementBounds(store.document.elements.find((element) => element.id === `brd-column-${index}-border`)!));
    for (const [index, column] of columns.entries()) for (const other of columns.slice(index + 1)) assert.equal(boundsOverlapArea(column, other), 0, "columns do not overlap");
    for (const [column, cards] of [[0, 2], [1, 1], [2, 2]] as const) {
      for (let card = 0; card < cards; card += 1) {
        const box = elementBounds(store.document.elements.find((element) => element.id === `brd-card-${column}-${card}-card`)!);
        const frame = columns[column];
        assert.ok(box.minX >= frame.minX && box.maxX <= frame.maxX && box.maxY <= frame.maxY, `card ${column}/${card} stays in its column`);
      }
    }
    const header = store.document.elements.find((element) => element.id === "brd-column-0-title");
    assert.ok(header?.type === "text" && header.text.includes("2"), "the column header carries its card count");
  }

  /* Roadmap bars land in the right lane and period, and milestones are diamonds. */
  {
    const composed = composeVisual({ kind: "roadmap", id: "rm", title: "Next month",
      lanes: ["Agent", "Canvas"], periods: ["W1", "W2", "W3", "W4"],
      items: [{ lane: "Agent", label: "Sequence", start: 0, span: 2 }, { lane: "Canvas", label: "Routing", start: 2, span: 1 }, { lane: "Canvas", label: "Demo", start: 3, milestone: true }] });
    const store = boardFrom(composed);
    assert.deepEqual(lintBoard(store.document).filter((issue) => issue.code === "overlap" || issue.code === "text-overflow"), [], "a roadmap composes clean");
    const bar = elementBounds(store.document.elements.find((element) => element.id === "rm-item-0")!);
    const second = elementBounds(store.document.elements.find((element) => element.id === "rm-item-1")!);
    assert.ok(bar.maxY <= second.minY, "the first lane sits above the second");
    assert.ok(bar.maxX - bar.minX > second.maxX - second.minX, "a two-period bar is wider than a one-period bar");
    const milestone = store.document.elements.find((element) => element.id === "rm-item-2")!;
    assert.equal(milestone.type === "shape" && milestone.kind, "polygon", "a milestone is a diamond, which is an editable polygon");
    assert.ok(second.maxX <= elementBounds(milestone).minX + 1, "the milestone comes after the bar before it");
  }

  /* A composition with no coordinates is dropped into free space, never onto existing work. */
  {
    storage.clear();
    const store = new BoardStore();
    const session = new CollaborationSession(store);
    const build = async (id: string): Promise<void> => {
      session.submit({ promptText: "draw", instructionInk: [] });
      const claimed = await session.waitForTurn(50);
      await session.compose({ kind: "board", id, title: id, columns: [{ name: "Work", cards: [{ label: "One" }, { label: "Two" }] }] }, undefined, String(claimed.leaseToken));
      session.complete("done", String(claimed.leaseToken));
      session.accept();
    };
    await build("first");
    await build("second");
    const first = elementBounds(store.document.elements.find((element) => element.id === "first-column-0-border")!);
    const second = elementBounds(store.document.elements.find((element) => element.id === "second-column-0-border")!);
    assert.equal(boundsOverlapArea(first, second), 0, "the second composition does not land on the first");
    assert.ok(second.minY > first.maxY, "it goes below what was already there");
    assert.deepEqual(lintBoard(store.document).filter((issue) => issue.code === "overlap"), [], "and the board stays clean");
  }

  /* Long detail is split: headline on the card, the rest in the narration. */
  {
    const long = "Every request stands alone and carries everything the server needs. Cookies, tokens and caches are what make a series of requests feel like a session.";
    const split = splitDetail(long);
    assert.ok(split.summary!.length < long.length, "the card gets a headline");
    assert.equal(split.body, long, "the narration keeps the whole thing");
    const composed = composeVisualDetailed({ kind: "guided_explainer", id: "split", title: "Stateless",
      nodes: [{ id: "state", label: "Stateless by design", detail: long }] });
    const note = composed.operations.find((operation): operation is Extract<CanvasOperation, { type: "create_note" }> => operation.type === "create_note")!;
    const sequence = composed.operations.find((operation): operation is Extract<CanvasOperation, { type: "set_explanation_sequence" }> => operation.type === "set_explanation_sequence")!;
    assert.ok(note.text.length < long.length, "the card is not a wall of prose");
    assert.equal(sequence.sequence.steps[0].body, long, "the full text survives as narration");
  }

  /* A wordy card is reported rather than rewritten, for the shapes that have no narration. */
  {
    const store = boardFrom([{ type: "create_note", id: "wordy", x: 0, y: 0, width: 320, text: "x".repeat(300) }]);
    assert.ok(lintBoard(store.document).some((issue) => issue.code === "wordy-card"), "a paragraph on a card is reported");
  }

  /* Connectors go around a box, and their labels sit beside the line. */
  {
    const store = boardFrom([
      box("from", 0, 0, 120, 90),
      box("blocker", 200, 0, 120, 90),
      box("to", 400, 0, 120, 90)
    ]);
    const [from, blocker, to] = ["from", "blocker", "to"].map((id) => store.document.elements.find((element) => element.id === id)!);
    const obstacles = [elementBounds(blocker)];
    assert.equal(routeBlocked(connectionRoute(from, to, "orthogonal"), obstacles), true, "the direct route really is blocked");
    assert.equal(routeBlocked(connectionRoute(from, to, "orthogonal", obstacles), obstacles), false, "so the connector goes around it");

    store.applyOperation({ type: "connect", id: "edge", fromId: "from", toId: "to", label: "sends", route: "orthogonal" }, "agent");
    store.changed();
    const label = store.document.elements.find((element) => element.type === "text" && element.text === "sends")!;
    const arrow = store.document.elements.find((element) => element.id === "edge")!;
    assert.equal(boundsOverlapArea(elementBounds(label), elementBounds(blocker)), 0, "the label does not sit on the box in the middle");
    assert.ok(arrow.type === "shape" && arrow.points.length >= 2);
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
