import assert from "node:assert/strict";
import { elementBounds } from "../src/document";
import { isSketchShape, shapeOutline, sketchOutline } from "../src/rendering";
import { BoardStore } from "../web-src/store";
import { CollaborationSession } from "../web-src/collaboration";
import { CanvasOperation, boundsOverlapArea, connectionRoute, iconNames, iconSegments, lintBoard, plannedElementIds, preflightOperations } from "../web-src/model";
import { composeVisual } from "../web-src/compositions";
import { exportPages, makeSvg } from "../web-src/export";
import { measureTextBlock } from "../web-src/measure";
import { designSystem } from "../web-src/theme";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key)
} });

function board(): BoardStore { storage.clear(); return new BoardStore(); }
const box = (id: string, x: number, y: number, width = 120, height = 90): CanvasOperation => ({ type: "create_shape", id, kind: "rectangle", x, y, width, height });

async function claimedSession(): Promise<{ store: BoardStore; session: CollaborationSession; lease: string }> {
  const store = board();
  const session = new CollaborationSession(store);
  session.submit({ promptText: "Draw", instructionInk: [] });
  const claimed = await session.waitForTurn(50);
  return { store, session, lease: String(claimed.leaseToken) };
}

async function main(): Promise<void> {
  /* Cards are sized from their text instead of a constant. */
  {
    const short = composeVisual({ kind: "research_report", id: "short", title: "Brief", width: 360, sections: [{ heading: "One", body: "Two words." }] });
    const long = composeVisual({ kind: "research_report", id: "long", title: "Brief", width: 360, sections: [{ heading: "One", body: "A considerably longer section body that has to wrap over several lines before it fits into the card the composer creates for it, which is exactly the case that used to overflow." }] });
    const height = (operations: CanvasOperation[], id: string): number => {
      const shape = operations.find((operation): operation is Extract<CanvasOperation, { type: "create_shape" }> => operation.type === "create_shape" && operation.id === id);
      return shape?.height ?? 0;
    };
    assert.ok(height(long, "long-section-0") > height(short, "short-section-0"), "a longer section produces a taller card");
    const text = long.find((operation): operation is Extract<CanvasOperation, { type: "create_text" }> => operation.type === "create_text" && operation.id === "long-section-0-label")!;
    const measured = measureTextBlock({ text: text.text, width: text.width!, fontSize: text.fontSize! });
    assert.ok(height(long, "long-section-0") >= measured.height, "the card is at least as tall as its measured text");
  }

  /* A composed board is free of text-overflow warnings. */
  {
    const store = board();
    for (const operation of composeVisual({ kind: "study_note", id: "notes", title: "Photosynthesis", sections: [
      { heading: "Light reaction", body: "Chlorophyll absorbs photons and splits water into oxygen, protons and electrons." },
      { heading: "Calvin cycle", body: "The cell fixes carbon dioxide into sugar using the ATP and NADPH from the light reaction." }
    ] })) store.applyOperation(operation, "agent");
    store.changed();
    const overflow = lintBoard(store.document).filter((issue) => issue.code === "text-overflow");
    assert.deepEqual(overflow, [], "measured layout does not produce overflowing text");
  }

  /* The linter reports the two rules that were declared but never emitted. */
  {
    const store = board();
    store.applyOperation(box("left", 0, 0, 200, 160), "human");
    store.applyOperation(box("right", 40, 20, 200, 160), "human");
    store.applyOperation({ type: "create_shape", id: "nameless", kind: "rectangle", x: 900, y: 0, width: 120, height: 60, semanticRole: "button" }, "human");
    store.changed();
    const codes = lintBoard(store.document).map((issue) => issue.code);
    assert.ok(codes.includes("overlap"), "unrelated overlapping objects are reported");
    assert.ok(codes.includes("unlabelled-control"), "a control without a label is reported");
    const labelled = board();
    labelled.applyOperation(box("card", 0, 0, 300, 220), "agent");
    labelled.applyOperation({ type: "create_text", id: "card-label", x: 20, y: 40, width: 200, text: "Label inside the card" }, "agent");
    labelled.changed();
    assert.deepEqual(lintBoard(labelled.document).filter((issue) => issue.code === "overlap"), [], "a label lying inside a card is a layout pattern, not an overlap defect");
    const spilling = board();
    spilling.applyOperation(box("small-card", 0, 0, 300, 60), "agent");
    spilling.applyOperation({ type: "create_text", id: "spill", x: 20, y: 20, width: 200, text: "A label that is far too long for the little card it was dropped into" }, "agent");
    spilling.changed();
    assert.ok(lintBoard(spilling.document).some((issue) => issue.code === "overlap"), "a label that spills out of its card is still reported");
    assert.ok(lintBoard(store.document).every((issue) => !/[äöüß]/i.test(issue.message)), "lint messages are English");
  }

  /* Grouped elements are not reported as overlapping each other. */
  {
    const store = board();
    store.applyOperation({ type: "create_note", id: "note", x: 0, y: 0, text: "Card and label belong together" }, "agent");
    store.changed();
    assert.deepEqual(lintBoard(store.document).filter((issue) => issue.code === "overlap"), [], "a note card and its own text are not an overlap defect");
  }

  /* The agent sees lint for what it just drew. */
  {
    const { session, lease } = await claimedSession();
    const applied = await session.apply([
      { type: "create_shape", id: "tiny", kind: "rectangle", x: 0, y: 0, width: 20, height: 20, semanticRole: "button" }
    ], undefined, lease);
    assert.equal(applied.ok, true);
    const issues = applied.lintIssues as Array<{ code: string; elementIds: string[] }>;
    assert.ok(issues.some((issue) => issue.code === "small-target" && issue.elementIds.includes("tiny")), "apply returns lint about the elements it just created");
  }

  /* Every composite operation creates exactly the ids the preflight predicts. */
  {
    const composites: CanvasOperation[] = [
      { type: "create_note", id: "c-note", x: 0, y: 0, text: "Note" },
      { type: "create_frame", id: "c-frame", x: 0, y: 400, width: 300, height: 200, title: "Frame" },
      { type: "create_frame", id: "c-frame-untitled", x: 400, y: 400, width: 300, height: 200 },
      { type: "create_table", id: "c-table", x: 0, y: 700, width: 300, height: 120, rows: 2, columns: 2, headers: ["A", "B"], cells: ["", "", "c", "d"] },
      { type: "create_icon", id: "c-icon", name: "warning", x: 0, y: 900 },
      { type: "create_callout", id: "c-callout", x: 500, y: 0, text: "Look here" },
      { type: "create_path", id: "c-path", points: [{ x: 0, y: 1000 }, { x: 60, y: 1040 }, { x: 120, y: 1000 }] },
      { type: "create_shape", id: "c-diamond", kind: "diamond", x: 600, y: 600, width: 120, height: 90 }
    ];
    for (const operation of composites) {
      const store = board();
      const created = store.applyOperation(operation, "agent");
      assert.deepEqual(created.sort(), plannedElementIds(operation).sort(), `${operation.type} creates the ids the preflight predicts`);
    }
    const anchored: CanvasOperation = { type: "create_callout", id: "anchored", x: 400, y: 0, text: "Points at the box", anchorId: "target" };
    const store = board();
    store.applyOperation(box("target", 0, 0), "human");
    assert.deepEqual(store.applyOperation(anchored, "agent").sort(), plannedElementIds(anchored).sort(), "an anchored callout also creates its leader line");
    assert.equal(preflightOperations([anchored], ["target"]).ok, true);
    assert.equal(preflightOperations([{ type: "create_callout", id: "floating", x: 0, y: 0, text: "x", anchorId: "ghost" }], []).ok, false, "a callout anchored to nothing is refused");
  }

  /* Diamonds and triangles are ordinary editable polygons. */
  {
    const store = board();
    store.applyOperation({ type: "create_shape", id: "decision", kind: "diamond", x: 0, y: 0, width: 100, height: 80 }, "agent");
    const shape = store.document.elements[0];
    assert.equal(shape.type === "shape" && shape.kind, "polygon");
    assert.deepEqual(elementBounds(shape), { minX: 0, minY: 0, maxX: 100, maxY: 80 });
  }

  /* Free-hand paths are smoothed and can be bowed into an arc. */
  {
    const store = board();
    store.applyOperation({ type: "create_path", id: "arc", points: [{ x: 0, y: 0 }, { x: 200, y: 0 }], bow: 60 }, "agent");
    const arc = store.document.elements[0];
    assert.ok(arc.type === "shape" && arc.points.length > 8, "a bowed two-point path becomes a curve");
    const bow = arc.type === "shape" ? Math.max(...arc.points.map((point) => Math.abs(point.y))) : 0;
    assert.ok(bow > 20, "the bow leaves the straight line");
  }

  /* auto_layout removes overlaps; fit_to_content sizes a container to its text. */
  {
    const store = board();
    store.applyOperation(box("a", 0, 0, 120, 90), "agent");
    store.applyOperation(box("b", 10, 10, 120, 90), "agent");
    store.applyOperation(box("c", 20, 20, 120, 90), "agent");
    store.applyOperation({ type: "auto_layout", ids: ["a", "b", "c"], direction: "row", gap: 24 }, "agent");
    store.changed();
    const boxes = ["a", "b", "c"].map((id) => elementBounds(store.document.elements.find((element) => element.id === id)!));
    assert.equal(boundsOverlapArea(boxes[0], boxes[1]), 0, "a row layout separates the units");
    assert.equal(boundsOverlapArea(boxes[1], boxes[2]), 0);
    assert.ok(Math.abs(boxes[1].minX - boxes[0].maxX - 24) < 0.01, "the requested gap is used");

    const grid = board();
    grid.applyOperation(box("g1", 0, 0), "agent"); grid.applyOperation(box("g2", 0, 0), "agent");
    grid.applyOperation(box("g3", 0, 0), "agent"); grid.applyOperation(box("g4", 0, 0), "agent");
    grid.applyOperation({ type: "auto_layout", ids: ["g1", "g2", "g3", "g4"], direction: "grid", columns: 2, gap: 10 }, "agent");
    grid.changed();
    const cells = ["g1", "g2", "g3", "g4"].map((id) => elementBounds(grid.document.elements.find((element) => element.id === id)!));
    assert.equal(boundsOverlapArea(cells[0], cells[3]), 0, "a grid layout separates every cell");
    assert.ok(cells[2].minY > cells[0].maxY - 0.01, "the second grid row sits below the first");

    const fitting = board();
    fitting.applyOperation({ type: "create_note", id: "card", x: 0, y: 0, width: 260, height: 400, text: "Short" }, "agent");
    fitting.applyOperation({ type: "update_text", id: "card-text", text: "A much longer note body that needs several lines once it is wrapped into the card width." }, "agent");
    fitting.applyOperation({ type: "fit_to_content", id: "card-card" }, "agent");
    fitting.changed();
    const card = elementBounds(fitting.document.elements.find((element) => element.id === "card-card")!);
    const label = fitting.document.elements.find((element) => element.id === "card-text")!;
    assert.ok(card.maxY - card.minY < 400, "the container shrinks to what it actually contains");
    assert.ok(card.maxY >= elementBounds(label).maxY, "the container still contains its text");
  }

  /* Connector routes leave the direct line and stay anchored to the objects. */
  {
    const store = board();
    store.applyOperation(box("from", 0, 0, 120, 90), "agent");
    store.applyOperation(box("to", 400, 300, 120, 90), "agent");
    const from = store.document.elements[0]; const to = store.document.elements[1];
    assert.equal(connectionRoute(from, to, "straight").length, 2);
    const orthogonal = connectionRoute(from, to, "orthogonal");
    assert.equal(orthogonal.length, 4, "an orthogonal route has two corners");
    assert.ok(orthogonal[0].x === 120 || orthogonal[0].y === 90, "the route starts on an edge of the source");
    const curved = connectionRoute(from, to, "curved");
    assert.ok(curved.length > 8, "a curved route is sampled into a smooth path");
    const middle = curved[Math.floor(curved.length / 2)];
    const straightMiddle = { x: (curved[0].x + curved.at(-1)!.x) / 2, y: (curved[0].y + curved.at(-1)!.y) / 2 };
    assert.ok(Math.hypot(middle.x - straightMiddle.x, middle.y - straightMiddle.y) > 10, "the curve bows away from the straight line");

    store.applyOperation({ type: "connect", id: "edge", fromId: "from", toId: "to", route: "curved" }, "agent");
    store.changed();
    const edge = store.document.elements.find((element) => element.id === "edge")!;
    assert.ok(edge.type === "shape" && edge.points.length > 8, "a curved connector keeps its route through refreshConnections");
    store.applyOperation({ type: "translate", ids: ["to"], dx: 120, dy: 60 }, "human");
    store.changed();
    const moved = store.document.elements.find((element) => element.id === "edge")!;
    assert.ok(moved.type === "shape" && moved.points.length > 8, "the route survives a human move");
  }

  /* Hand-drawn geometry is deterministic, so canvas and SVG cannot drift apart. */
  {
    const store = board();
    store.applyOperation({ type: "create_shape", id: "sketchy", kind: "rectangle", x: 0, y: 0, width: 200, height: 120, radius: 16 }, "agent");
    const shape = store.document.elements[0];
    assert.ok(shape.type === "shape");
    if (shape.type === "shape") {
      shape.renderStyle = "sketch";
      assert.equal(isSketchShape(shape), true);
      assert.deepEqual(sketchOutline(shape, 0), sketchOutline(shape, 0), "the same shape always produces the same hand-drawn path");
      assert.notDeepEqual(sketchOutline(shape, 0), sketchOutline(shape, 1), "the two passes differ");
      const clean = shapeOutline(shape);
      const drawn = sketchOutline(shape, 0);
      assert.ok(drawn.length >= clean.length, "the outline is resampled before it wobbles");
      const drift = Math.max(...drawn.map((point, index) => Math.hypot(point.x - (clean[Math.min(index, clean.length - 1)]?.x ?? 0), point.y - (clean[Math.min(index, clean.length - 1)]?.y ?? 0))));
      assert.ok(Number.isFinite(drift), "the wobble stays finite");
      const other = { ...shape, id: "different" };
      assert.notDeepEqual(sketchOutline(shape, 0), sketchOutline(other, 0), "two shapes do not get the identical hand");
      store.changed();
      const svg = makeSvg(exportPages(store.document)[0]);
      assert.ok(svg.includes("<polygon"), "a sketch shape exports as its drawn outline, not a plain rect");
      const polygon = /<polygon points="([^"]+)"/.exec(svg);
      assert.ok(polygon, "the sketch outline reaches the SVG");
      assert.equal(polygon![1].trim().split(/\s+/).length, sketchOutline(shape, 0).length, "the SVG uses the same seeded geometry as the canvas");
    }
  }

  /* Icons the agent can reach for. */
  {
    for (const name of iconNames) assert.ok(iconSegments(name, 0, 0, 32).length > 0, `${name} has a drawable path`);
    const store = board();
    const created = store.applyOperation({ type: "create_icon", id: "warn", name: "warning", x: 0, y: 0 }, "agent");
    assert.ok(created.length >= 1 && created.every((id) => id.startsWith("warn-")));
  }

  /* Teaching: the agent can move the human through a guided explanation. */
  {
    const { store, session, lease } = await claimedSession();
    const built = await session.compose({
      kind: "guided_explainer", id: "cell", title: "Cell",
      nodes: [{ id: "membrane", label: "Membrane", detail: "Separates inside from outside." }, { id: "nucleus", label: "Nucleus", detail: "Holds the DNA." }],
      presentationSteps: [{ title: "Outside", body: "Start at the membrane.", focusIds: ["membrane"] }, { title: "Inside", body: "Then look at the nucleus.", focusIds: ["nucleus"] }]
    }, undefined, lease);
    assert.equal(built.ok, true);
    const sequence = store.document.explanationSequences[0];
    assert.equal(sequence.steps.length, 2);
    assert.equal(sequence.steps[0].body, "Start at the membrane.", "the step text the agent wrote is kept");
    assert.ok(sequence.steps[0].cameraBounds, "each step carries its own camera");
    assert.notDeepEqual(sequence.steps[0].cameraBounds, sequence.steps[1].cameraBounds, "the camera actually moves between steps");

    const presented = await session.apply([{ type: "present_step", sequenceId: sequence.id, index: 1 }], undefined, lease);
    assert.equal(presented.ok, true);
    assert.deepEqual(store.document.presentation, { sequenceId: sequence.id, index: 1 }, "present_step persists what the human is looking at");
    const inspected = session.inspect("all");
    const active = inspected.activePresentation as { stepIndex: number; title: string; body: string | null };
    assert.equal(active.stepIndex, 1);
    assert.equal(active.title, "Inside");
    assert.equal(active.body, "Then look at the nucleus.", "the agent can read the step the human is on");
    await session.apply([{ type: "present_step", index: 99 }], undefined, lease);
    assert.equal(store.document.presentation?.index, 1, "a step index beyond the sequence is clamped");
  }

  /* The shared design vocabulary reaches the agent. */
  {
    const session = new CollaborationSession(board());
    const inspected = session.inspect("all");
    assert.deepEqual(inspected.designSystem, designSystem);
    assert.equal((inspected.designSystem as typeof designSystem).minimumTouchTarget, 44, "the palette and the lint rule agree on the same numbers");
  }

  console.log("authoring tests: ok");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
