import assert from "node:assert/strict";
import { CollaborationSession, CollaborationView } from "../web-src/collaboration";
import { BoardStore } from "../web-src/store";
import { CanvasOperation, resolveGestureElements } from "../web-src/model";
import { InkPoint } from "../src/strokes";
import { registerWhiteboardTools } from "../web-src/webmcp";

/* ------------------------------- harness ------------------------------- */

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key)
} });

const point = (x: number, y: number): InkPoint => ({ x, y, pressure: 0.5 });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Harness { store: BoardStore; session: CollaborationSession; selection: string[]; delay: { ms: number }; focused: Array<{ minX: number; minY: number; maxX: number; maxY: number }> }

function harness(options: { keepStorage?: boolean } = {}): Harness {
  if (!options.keepStorage) storage.clear();
  const state = { selection: [] as string[], delay: { ms: 0 }, focused: [] as Array<{ minX: number; minY: number; maxX: number; maxY: number }> };
  const store = new BoardStore();
  const view: CollaborationView = {
    viewport: () => ({ x: 0, y: 0, zoom: 1, width: 1280, height: 800 }),
    focus: (bounds) => { state.focused.push(bounds); },
    liveSelectionIds: () => state.selection,
    status: () => undefined,
    refresh: () => undefined,
    operationDelay: () => state.delay.ms
  };
  const session = new CollaborationSession(store, view);
  return { store, session, get selection() { return state.selection; }, set selection(value: string[]) { state.selection = value; }, delay: state.delay, focused: state.focused } as Harness;
}

/** Human draws something; the store diff is the only mutation channel, exactly as in the app. */
function humanApply(store: BoardStore, ...operations: CanvasOperation[]): string[] {
  store.checkpoint();
  const created = operations.flatMap((operation) => store.applyOperation(operation, "human"));
  store.changed();
  return created;
}

const box = (id: string, x: number, y: number, width = 100, height = 80): CanvasOperation => ({ type: "create_shape", id, kind: "rectangle", x, y, width, height });
const claim = async (test: Harness): Promise<{ leaseToken: string; turnId: string }> => {
  const claimed = await test.session.waitForTurn(50);
  assert.equal(claimed.state, "claimed", "a queued human turn is claimed immediately");
  return { leaseToken: String(claimed.leaseToken), turnId: String(claimed.turnId) };
};

async function main(): Promise<void> {
  /* TEST 1 — an idle session may not write. */
  {
    const test = harness();
    const started = test.session.session();
    assert.equal(started.state, "idle");
    assert.equal(started.canWrite, false);
    assert.equal(started.hasLease, false);
    assert.equal(started.nextAction, "wait_for_human_turn");
    const write = await test.session.apply([box("intruder", 0, 0)], undefined, "made-up-lease");
    assert.equal(write.ok, false);
    assert.equal(write.error, "no_claimed_turn");
    assert.equal(test.store.document.elements.length, 0, "an idle agent cannot mutate the canvas");
  }

  /* TEST 2 — waiting is not a licence to write. */
  {
    const test = harness();
    const waited = await test.session.waitForTurn(20);
    assert.equal(waited.state, "waiting");
    assert.equal(waited.canWrite, false);
    assert.equal(waited.nextAction, "wait_for_human_turn");
    const visual = await test.session.compose({ kind: "mindmap", id: "sneaky", nodes: [{ id: "a", label: "A" }] }, undefined, undefined);
    assert.equal(visual.ok, false);
    assert.equal(visual.error, "no_claimed_turn");
    assert.equal(test.store.document.elements.length, 0, "a waiting agent cannot mutate the canvas");
  }

  /* TEST 3 — wait_for_human_turn is state aware and never opens a second waiting cycle. */
  {
    const test = harness();
    humanApply(test.store, box("target", 0, 0));
    test.session.submit({ promptText: "Explain this", instructionInk: [] });
    const lease = await claim(test);

    const again = await test.session.waitForTurn(20);
    assert.equal(again.state, "claimed");
    assert.equal(again.leaseToken, lease.leaseToken, "waiting during a claimed turn returns that turn instead of a new wait");
    assert.equal(again.canWrite, true);

    await test.session.apply([box("agent-a", 200, 0)], undefined, lease.leaseToken);
    const working = await test.session.waitForTurn(20);
    assert.equal(working.state, "working");
    assert.equal(working.canWrite, true);
    assert.equal(working.awaitingHumanDecision, false);

    test.session.complete("done", lease.leaseToken);
    const review = await test.session.waitForTurn(20);
    assert.equal(review.state, "review");
    assert.equal(review.canWrite, false);
    assert.equal(review.awaitingHumanDecision, true);
    assert.equal(review.nextAction, "wait_for_human_decision");

    test.session.accept();
    const afterAccept = await test.session.waitForTurn(20);
    assert.equal(afterAccept.state, "waiting", "a finished turn returns to waiting for the next human turn");
  }

  /* TEST 4 — claiming returns a usable lease and capabilities. */
  {
    const test = harness();
    test.session.submit({ promptText: "Draw a cell", instructionInk: [] });
    assert.equal(test.session.state(), "queued");
    const claimed = await test.session.waitForTurn(50);
    assert.equal(claimed.state, "claimed");
    assert.equal(claimed.canWrite, true);
    assert.equal(claimed.hasLease, true);
    assert.ok(typeof claimed.leaseToken === "string" && claimed.leaseToken.length > 10);
    assert.ok(typeof claimed.turnId === "string" && String(claimed.turnId).startsWith("turn-"));
    assert.equal(claimed.promptText, "Draw a cell");
    assert.equal(claimed.contextScope, "all");
    assert.equal(claimed.contentTrust, "untrusted-user-content");
  }

  /* TEST 5 + 6 — a missing or wrong lease is refused without touching the canvas. */
  {
    const test = harness();
    test.session.submit({ promptText: "Draw", instructionInk: [] });
    const lease = await claim(test);
    const missing = await test.session.apply([box("no-lease", 0, 0)]);
    assert.equal(missing.error, "missing_lease");
    const wrong = await test.session.apply([box("wrong-lease", 0, 0)], undefined, `${lease.leaseToken}-x`);
    assert.equal(wrong.error, "invalid_lease");
    assert.equal(test.store.document.elements.length, 0, "rejected writes leave the board untouched");
    assert.equal(test.session.publishPlan("plan", undefined).error, "missing_lease");
    assert.equal(test.session.complete("done", "nonsense").error, "invalid_lease");
    assert.equal(test.session.focus({ minX: 0, minY: 0, maxX: 10, maxY: 10 }).error, "missing_lease", "moving the human camera also needs the lease");
  }

  /* TEST 7 — the lease dies with the accepted turn. */
  {
    const test = harness();
    test.session.submit({ promptText: "Draw", instructionInk: [] });
    const lease = await claim(test);
    await test.session.apply([box("kept", 0, 0)], undefined, lease.leaseToken);
    test.session.complete("done", lease.leaseToken);
    assert.equal(test.session.accept(), true);
    const late = await test.session.apply([box("late", 300, 0)], undefined, lease.leaseToken);
    assert.equal(late.error, "no_claimed_turn");
    assert.equal(test.store.document.elements.some((element) => element.id === "late"), false);
    assert.equal(test.store.document.elements.some((element) => element.id === "kept"), true, "accepted work stays on the board");
  }

  /* TEST 8 — the lease dies with the rejected turn. */
  {
    const test = harness();
    test.session.submit({ promptText: "Draw", instructionInk: [] });
    const lease = await claim(test);
    await test.session.apply([box("proposed", 0, 0)], undefined, lease.leaseToken);
    test.session.complete("done", lease.leaseToken);
    assert.equal(test.session.reject(), true);
    assert.equal(test.store.document.elements.some((element) => element.id === "proposed"), false, "reject restores the pre-agent board");
    const late = await test.session.apply([box("late", 0, 0)], undefined, lease.leaseToken);
    assert.equal(late.error, "no_claimed_turn");
  }

  /* TEST 9 — a global prompt inspects the board, never an empty priority list. */
  {
    const seed = harness();
    humanApply(seed.store, box("one", 0, 0), box("two", 200, 0), box("three", 400, 0));
    // Reopen the same board so nothing is queued as a recent edit: the pure "existing board" case.
    const test = harness({ keepStorage: true });
    const submitted = test.session.submit({ promptText: "Organize this board.", instructionInk: [] });
    assert.equal(submitted.ok, true);
    assert.equal(submitted.turn?.contextScope, "all");
    assert.equal(submitted.turn?.priorityRegions.length, 0, "a global prompt has no priority region at all");
    await claim(test);
    assert.equal(test.store.document.turn?.contextScope, "all");
    const inspected = test.session.inspect();
    assert.equal(inspected.appliedScope, "all");
    assert.equal((inspected.elements as unknown[]).length, 3, "a prompt without selection sees the whole board");
    const priority = test.session.inspect("priority");
    assert.equal(priority.scopeFallback, "all", "an empty priority scope falls back to the board instead of returning nothing");
    assert.equal((priority.elements as unknown[]).length, 3);
  }

  /* TEST 10 — the AI pen resolves the objects it points at. */
  {
    const test = harness();
    humanApply(test.store, box("left", 0, 0), box("right", 160, 0), box("far-away", 3000, 3000));
    const gesture = [[point(40, 40), point(150, 45), point(240, 40)]];
    const submitted = test.session.submit({ promptText: "Explain these", instructionInk: gesture });
    const region = submitted.turn?.priorityRegions.find((candidate) => candidate.source === "ai-pen");
    assert.ok(region, "an AI pen gesture becomes a priority region");
    assert.ok(region!.elementIds.includes("left") && region!.elementIds.includes("right"), "the gesture resolves the elements it covers");
    assert.equal(region!.elementIds.includes("far-away"), false, "unrelated content stays out of the pointing context");
    assert.equal(submitted.turn?.contextScope, "priority");
    await claim(test);
    const priority = test.session.inspect("priority");
    const ids = (priority.elements as Array<{ id: string }>).map((element) => element.id);
    assert.ok(ids.includes("left") && ids.includes("right"));
    assert.equal(resolveGestureElements([], { minX: 0, minY: 0, maxX: 10, maxY: 10 }).length, 0, "an empty board resolves to nothing");
  }

  /* TEST 11 — the submitted selection is frozen for the whole turn. */
  {
    const test = harness();
    humanApply(test.store, box("A", 0, 0), box("B", 400, 0));
    test.selection = ["A"];
    const submitted = test.session.submit({ promptText: "Improve this", instructionInk: [] });
    assert.equal(submitted.turn?.contextScope, "selection");
    await claim(test);
    test.selection = ["B"];
    const inspected = test.session.inspect("selection");
    const ids = (inspected.elements as Array<{ id: string }>).map((element) => element.id);
    assert.deepEqual(ids, ["A"], "changing the live selection after Send must not change the turn context");
  }

  /* TEST 12 — publishing a plan does not invalidate the inspected revision. */
  {
    const test = harness();
    humanApply(test.store, box("base", 0, 0));
    test.session.submit({ promptText: "Extend", instructionInk: [] });
    const lease = await claim(test);
    const inspected = test.session.inspect();
    const revision = inspected.revision as number;
    const plan = test.session.publishPlan("Add one label", lease.leaseToken);
    assert.equal(plan.ok, true);
    assert.equal(plan.revision, revision, "session metadata does not bump the canvas revision");
    const applied = await test.session.apply([box("added", 200, 0)], revision, lease.leaseToken);
    assert.equal(applied.ok, true, "the plan did not create a false stale revision");
    const stale = await test.session.apply([box("later", 400, 0)], revision, lease.leaseToken);
    assert.equal(stale.error, "stale_revision", "a real content change is still detected");
  }

  /* TEST 13 + 14 + 15 — human move, resize and delete become next-turn context. */
  {
    const test = harness();
    test.session.submit({ promptText: "Draw two boxes", instructionInk: [] });
    const lease = await claim(test);
    await test.session.apply([box("moved", 0, 0), box("resized", 300, 0), box("doomed", 600, 0)], undefined, lease.leaseToken);
    test.session.complete("done", lease.leaseToken);
    test.session.accept();

    humanApply(test.store, { type: "translate", ids: ["moved"], dx: 120, dy: 40 });
    humanApply(test.store, { type: "resize", id: "resized", x: 300, y: 0, width: 220, height: 160 });
    humanApply(test.store, { type: "delete", ids: ["doomed"] });

    const edits = test.session.recentHumanEditIds();
    assert.ok(edits.includes("moved"), "a human move is tracked centrally");
    assert.ok(edits.includes("resized"), "a human resize is tracked centrally");
    assert.equal(edits.includes("doomed"), false, "a deleted element cannot be referenced any more");
    const deletions = test.session.recentHumanDeletions();
    assert.equal(deletions.length, 1);
    assert.ok(deletions[0].elementIds.includes("doomed"));
    assert.ok(deletions[0].bounds.minX >= 599 && deletions[0].bounds.minX <= 601, "the deleted region keeps its spatial position");

    const submitted = test.session.submit({ promptText: "Continue this layout", instructionInk: [] });
    assert.ok(submitted.turn?.changedElementIds.includes("moved"));
    assert.equal(submitted.turn?.deletedRegions?.length, 1);
    const next = await claim(test);
    assert.ok(String(next.turnId).length > 0);
    const inspected = test.session.inspect("all");
    const moved = (inspected.elements as Array<{ id: string; bounds: { minX: number } }>).find((element) => element.id === "moved");
    assert.ok(moved && moved.bounds.minX >= 119, "the agent sees the human position, not its own original one");
    assert.equal((inspected.elements as Array<{ id: string }>).some((element) => element.id === "doomed"), false, "deleted branches do not come back");
  }

  /* TEST 16 — Accept / Reject only exist in review. */
  {
    const test = harness();
    test.delay.ms = 6;
    test.session.submit({ promptText: "Draw a long batch", instructionInk: [] });
    const lease = await claim(test);
    const streaming = test.session.apply([box("s1", 0, 0), box("s2", 120, 0), box("s3", 240, 0), box("s4", 360, 0)], undefined, lease.leaseToken);
    await sleep(8);
    assert.equal(test.session.state(), "working");
    assert.equal(test.session.canResolveProposal(), false, "the human cannot resolve a proposal that is still streaming");
    assert.equal(test.session.accept(), false);
    assert.equal(test.session.reject(), false);
    assert.equal(test.session.canHumanMutateBoard(), false, "human edits are locked while the agent writes");
    await streaming;
    assert.equal(test.session.canResolveProposal(), false, "still not resolvable before the agent completes the turn");
    test.session.complete("ready", lease.leaseToken);
    assert.equal(test.session.state(), "review");
    assert.equal(test.session.canResolveProposal(), true);
    assert.equal(test.session.canHumanMutateBoard(), false, "the board stays locked until the proposal is resolved");
    test.session.accept();
    assert.equal(test.session.canHumanMutateBoard(), true);
  }

  /* TEST 17 + 18 — an aborted execution stops writing and leaves no late elements behind. */
  {
    const test = harness();
    test.delay.ms = 10;
    test.session.submit({ promptText: "Draw many", instructionInk: [] });
    const lease = await claim(test);
    const controller = new AbortController();
    const operations = Array.from({ length: 12 }, (_, index) => box(`abort-${index}`, index * 60, 0));
    const streaming = test.session.apply(operations, undefined, lease.leaseToken, controller.signal);
    await sleep(25);
    controller.abort();
    const outcome = await streaming;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, "cancelled");
    assert.equal(outcome.rolledBack, true);
    const afterAbort = test.store.document.elements.length;
    await sleep(200);
    assert.equal(test.store.document.elements.length, afterAbort, "no operation lands after the abort");
    assert.equal(test.store.document.elements.some((element) => element.id.startsWith("abort-")), false, "the aborted proposal is rolled back completely");
    assert.equal(test.store.document.turn?.status, "cancelled");
    assert.equal(test.session.canHumanMutateBoard(), true, "the human regains the board after a cancelled proposal");
  }

  /* TEST 19 — a human undo cannot run into a live stream. */
  {
    const test = harness();
    humanApply(test.store, box("human-shape", 0, 0));
    test.delay.ms = 6;
    test.session.submit({ promptText: "Add", instructionInk: [] });
    const lease = await claim(test);
    const streaming = test.session.apply([box("stream-1", 200, 0), box("stream-2", 320, 0), box("stream-3", 440, 0)], undefined, lease.leaseToken);
    await sleep(8);
    assert.equal(test.session.canHumanMutateBoard(), false, "undo, redo, clear and import are all gated by one central rule");
    const result = await streaming;
    assert.equal(result.ok, true);
    assert.ok(test.store.document.elements.some((element) => element.id === "human-shape"), "the human content survives the agent stream");
  }

  /* A human undo before the agent writes changes the canvas, never the open turn. */
  {
    const test = harness();
    humanApply(test.store, box("first", 0, 0));
    humanApply(test.store, box("second", 200, 0));
    test.session.submit({ promptText: "Continue", instructionInk: [] });
    const lease = await claim(test);
    assert.equal(test.store.undo(), true);
    assert.equal(test.store.document.elements.some((element) => element.id === "second"), false);
    assert.equal(test.session.state(), "claimed", "history steps do not delete the claimed turn");
    assert.equal(test.store.document.turn?.leaseToken, lease.leaseToken, "the lease survives a human undo");
    const applied = await test.session.apply([box("agent", 400, 0)], undefined, lease.leaseToken);
    assert.equal(applied.ok, true);
  }

  /* TEST 20 — an empty submission does not queue a turn. */
  {
    const test = harness();
    const empty = test.session.submit({ promptText: "   ", instructionInk: [] });
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, "empty_submission");
    assert.equal(test.store.document.turn, null);
    assert.equal(test.session.state(), "idle");
    const penOnly = test.session.submit({ promptText: "", instructionInk: [[point(5, 5), point(40, 40)]] });
    assert.equal(penOnly.ok, true, "an AI-pen-only turn is a valid request without any text");
  }

  /* TEST 21 — composite id collisions are rejected atomically. */
  {
    const test = harness();
    test.session.submit({ promptText: "Notes", instructionInk: [] });
    const lease = await claim(test);
    await test.session.apply([{ type: "create_note", id: "note", x: 0, y: 0, text: "First" }], undefined, lease.leaseToken);
    const before = test.store.document.elements.length;
    const collision = await test.session.apply([box("fresh", 500, 0), { type: "create_note", id: "note", x: 200, y: 0, text: "Second" }], undefined, lease.leaseToken);
    assert.equal(collision.ok, false);
    assert.equal(collision.error, "id_conflict");
    assert.deepEqual(collision.ids, ["note-card", "note-text"], "the check covers the concrete ids a composite creates, not just the prefix");
    assert.equal(test.store.document.elements.length, before, "a colliding batch applies zero operations");
    assert.equal(test.store.document.elements.some((element) => element.id === "fresh"), false);
    const internal = await test.session.apply([box("twin", 0, 200), box("twin", 100, 200)], undefined, lease.leaseToken);
    assert.equal(internal.error, "id_conflict", "duplicates inside one batch are caught too");
  }

  /* TEST 22 — a missing target fails loudly instead of silently doing nothing. */
  {
    const test = harness();
    humanApply(test.store, box("real", 0, 0));
    test.session.submit({ promptText: "Edit", instructionInk: [] });
    const lease = await claim(test);
    const before = test.store.document.elements.length;
    const missing = await test.session.apply([box("added", 200, 0), { type: "update_text", id: "ghost", text: "nope" }], undefined, lease.leaseToken);
    assert.equal(missing.ok, false);
    assert.equal(missing.error, "missing_target");
    assert.deepEqual(missing.ids, ["ghost"]);
    assert.equal(test.store.document.elements.length, before, "a batch with a missing target applies nothing");
    const chained = await test.session.apply([{ type: "create_text", id: "label", x: 0, y: 300, text: "Hello" }, { type: "update_text", id: "label", text: "Hello world" }], undefined, lease.leaseToken);
    assert.equal(chained.ok, true, "targets created earlier in the same batch are valid");
    const deleteGhost = await test.session.apply([{ type: "delete", ids: ["ghost"] }], undefined, lease.leaseToken);
    assert.equal(deleteGhost.error, "missing_target");
  }

  /* TEST 23 — a reload during an unfinished turn must not restore a usable lease. */
  {
    const test = harness();
    test.delay.ms = 0;
    test.session.submit({ promptText: "Draw", instructionInk: [] });
    const lease = await claim(test);
    await test.session.apply([box("half-done", 0, 0)], undefined, lease.leaseToken);
    assert.equal(test.store.document.turn?.status, "working");

    // Same localStorage, fresh objects: this is what a page reload does.
    const reloaded = harness({ keepStorage: true });
    assert.equal(reloaded.store.document.turn?.status, "cancelled", "an interrupted proposal is rolled back on reload");
    assert.equal(reloaded.store.document.elements.some((element) => element.id === "half-done"), false);
    assert.equal(reloaded.store.document.turn?.leaseToken, undefined, "the persisted lease is destroyed");
    const stale = await reloaded.session.apply([box("after-reload", 0, 0)], undefined, lease.leaseToken);
    assert.equal(stale.error, "no_claimed_turn", "a stale lease from before the reload authorises nothing");
    assert.equal(reloaded.session.canHumanMutateBoard(), true, "the human can keep working after the recovery");

    const review = harness();
    review.session.submit({ promptText: "Draw", instructionInk: [] });
    const reviewLease = await claim(review);
    await review.session.apply([box("proposal", 0, 0)], undefined, reviewLease.leaseToken);
    review.session.complete("done", reviewLease.leaseToken);
    const reloadedReview = harness({ keepStorage: true });
    assert.equal(reloadedReview.session.state(), "review", "a finished proposal survives a reload so the human can still decide");
    assert.equal(reloadedReview.store.document.turn?.leaseToken, undefined);
    const lateWrite = await reloadedReview.session.apply([box("late", 0, 0)], undefined, reviewLease.leaseToken);
    assert.equal(lateWrite.error, "no_claimed_turn");
    assert.equal(reloadedReview.session.reject(), true, "the restored proposal can still be rejected");
    assert.equal(reloadedReview.store.document.elements.some((element) => element.id === "proposal"), false);
  }

  /* Completing without any canvas change must not show an empty proposal. */
  {
    const test = harness();
    test.session.submit({ promptText: "Nothing to draw", instructionInk: [] });
    const lease = await claim(test);
    test.session.publishPlan("Nothing to change", lease.leaseToken);
    const completed = test.session.complete("No visual changes needed", lease.leaseToken);
    assert.equal(completed.ok, true);
    assert.equal(completed.visualChanges, false);
    assert.equal(test.session.state(), "complete");
    assert.equal(test.session.canResolveProposal(), false, "there is no empty Accept / Reject");
    assert.equal(test.session.canHumanMutateBoard(), true);
  }

  /* Inspect output stays compact on a handwritten board. */
  {
    const test = harness();
    const points = Array.from({ length: 400 }, (_, index) => point(index, Math.sin(index) * 20));
    humanApply(test.store, { type: "create_stroke", id: "scribble", points });
    const summary = test.session.inspect("all");
    const stroke = (summary.elements as Array<Record<string, unknown>>)[0];
    assert.equal(stroke.points, null, "handwriting is summarised, not dumped point by point");
    assert.equal(stroke.pointCount, 400);
    assert.ok(JSON.stringify(summary).length < 4000, "a summary inspect stays small");
    const geometry = test.session.inspect("all", "geometry");
    assert.equal(((geometry.elements as Array<Record<string, unknown>>)[0].points as unknown[]).length, 400, "geometry detail is available when it is really needed");
    const targeted = test.session.inspect("all", "geometry", ["scribble"]);
    assert.equal((targeted.elements as unknown[]).length, 1);
  }

  /* Old highlights elsewhere on the board do not hijack a new request. */
  {
    const seed = harness();
    humanApply(seed.store, { type: "create_highlight", id: "old-mark", x: 4000, y: 4000, width: 200 });
    humanApply(seed.store, { type: "create_highlight", id: "near-mark", x: 20, y: 20, width: 120 });
    humanApply(seed.store, box("subject", 0, 0));
    const test = harness({ keepStorage: true });
    const submitted = test.session.submit({ promptText: "Look here", instructionInk: [[point(10, 10), point(90, 60)]] });
    const highlightRegions = submitted.turn?.priorityRegions.filter((region) => region.source === "highlight") ?? [];
    assert.deepEqual(highlightRegions.flatMap((region) => region.elementIds), ["near-mark"], "only the mark inside the gesture joins the request; an old one elsewhere does not");
  }

  /* The WebMCP surface requires the lease where the runtime requires it. */
  {
    const registered: Array<{ name: string; description: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }> = [];
    Object.defineProperty(globalThis, "document", { configurable: true, value: { modelContext: { registerTool: (tool: { name: string; description: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }) => { registered.push(tool); } } } });
    const available = await registerWhiteboardTools({
      session: () => ({}), waitForTurn: async () => ({}), inspect: () => ({}), focus: () => ({}), publishPlan: () => ({}), apply: async () => ({}), compose: async () => ({}), complete: () => ({})
    }, new AbortController().signal);
    assert.equal(available, true);
    for (const name of ["publish_agent_plan", "apply_whiteboard_changes", "create_structured_visual", "complete_whiteboard_contribution", "focus_whiteboard_region"]) {
      const tool = registered.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} is registered`);
      assert.ok((tool!.inputSchema?.required as string[]).includes("leaseToken"), `${name} requires the lease token in its schema`);
      assert.ok(tool!.description.includes("leaseToken") || tool!.description.includes("lease"), `${name} says when it is valid`);
    }
    const readers = ["start_whiteboard_session", "wait_for_human_turn", "inspect_whiteboard"];
    for (const name of readers) assert.equal(registered.find((candidate) => candidate.name === name)?.annotations?.readOnlyHint, true, `${name} is annotated read-only`);
    assert.ok(registered.find((candidate) => candidate.name === "inspect_whiteboard")?.description.includes("untrusted"), "canvas content is advertised as untrusted data");
  }

  /* TEST 33 — the whole product loop. */
  {
    const test = harness();
    assert.equal(test.session.session().state, "idle");
    const waiting = await test.session.waitForTurn(20);
    assert.equal(waiting.state, "waiting");

    // 1. Human asks for an explanation.
    assert.equal(test.session.submit({ promptText: "Explain how neurons work.", instructionInk: [] }).ok, true);
    const first = await claim(test);
    const firstInspect = test.session.inspect();
    assert.equal(firstInspect.appliedScope, "all");
    assert.equal(test.session.publishPlan("Draw a labelled neuron", first.leaseToken).ok, true);
    const built = await test.session.compose({
      kind: "visual_explainer", id: "neuron", title: "Neuron",
      nodes: [{ id: "soma", label: "Soma" }, { id: "axon", label: "Axon" }, { id: "synapse", label: "Synapse" }]
    }, firstInspect.revision as number, first.leaseToken);
    assert.equal(built.ok, true, "the agent builds an editable explanation");
    assert.equal(test.session.canResolveProposal(), false, "review only opens when the agent says it is finished");
    test.session.complete("Neuron explanation ready", first.leaseToken);
    assert.equal(test.session.canResolveProposal(), true);
    assert.equal(test.session.accept(), true);

    // 2. Human edits the accepted result.
    const synapse = test.store.document.elements.find((element) => element.id === "neuron-idea-2-card");
    assert.ok(synapse, "the composed explanation is made of addressable editable objects");
    const synapseBefore = (test.session.inspect("all").elements as Array<{ id: string; bounds: { minX: number } }>).find((element) => element.id === "neuron-idea-2-card")!.bounds.minX;
    humanApply(test.store, { type: "translate", ids: ["neuron-idea-2-card"], dx: 260, dy: 120 });
    humanApply(test.store, { type: "delete", ids: ["neuron-idea-1-text"] });
    humanApply(test.store, { type: "create_stroke", id: "correction", points: [point(10, 500), point(120, 520)] });
    test.selection = ["neuron-idea-2-card"];

    // 3. Human asks for more detail on the corrected board.
    const second = test.session.submit({ promptText: "Explain this part in more detail.", instructionInk: [] });
    assert.equal(second.ok, true);
    assert.equal(second.turn?.contextScope, "selection");
    assert.ok(second.turn?.changedElementIds.includes("correction"), "the handwritten correction is part of the next turn");
    assert.ok(second.turn?.changedElementIds.includes("neuron-idea-2-card"), "the moved synapse is part of the next turn");
    assert.equal(second.turn?.deletedRegions?.length, 1, "the deleted label is reported as a spatial deletion");

    const secondLease = await claim(test);
    const context = test.session.inspect("selection");
    const contextIds = (context.elements as Array<{ id: string }>).map((element) => element.id);
    assert.deepEqual(contextIds, ["neuron-idea-2-card"], "the agent continues from what the human selected");
    const board = test.session.inspect("all");
    const movedSynapse = (board.elements as Array<{ id: string; bounds: { minX: number } }>).find((element) => element.id === "neuron-idea-2-card");
    assert.ok(movedSynapse && Math.abs(movedSynapse.bounds.minX - (synapseBefore + 260)) < 1, "the agent sees the human position of the synapse, not the one it generated");
    assert.equal((board.elements as Array<{ id: string }>).some((element) => element.id === "neuron-idea-1-text"), false, "the deleted label is really gone");
    const extended = await test.session.apply([{ type: "create_text", id: "synapse-detail", x: 300, y: 700, text: "Vesicles release transmitter", fontSize: 22 }], board.revision as number, secondLease.leaseToken);
    assert.equal(extended.ok, true);
    test.session.complete("Added synapse detail", secondLease.leaseToken);
    assert.equal(test.session.accept(), true);
    assert.ok(test.store.document.elements.some((element) => element.id === "synapse-detail"));
    assert.ok(test.store.document.elements.some((element) => element.id === "correction"), "human corrections survive the second agent turn");
    assert.equal(test.session.state(), "complete");
    assert.equal(test.session.canHumanMutateBoard(), true);
  }

  console.log("collaboration tests: ok");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
