import assert from "node:assert/strict";
import { CollaborationSession, CollaborationView } from "../web-src/collaboration";
import { BoardStore } from "../web-src/store";
import { PageElement, elementBounds } from "../src/document";
import { readFileSync } from "node:fs";
import { Bounds, CONNECTOR_LABEL_PADDING, CanvasOperation, annotationKinds, estimateTextHeight, reflowText, boardBounds, boundsOverlapArea, iconNames, isCanvasOperation, lintBoard, migrateBoard, plannedElementIds, resolveGestureElements } from "../web-src/model";
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
      session: () => ({}), waitForTurn: async () => ({}), inspect: () => ({}), focus: () => ({}), publishPlan: () => ({}), apply: async () => ({}), compose: async () => ({}), complete: () => ({}), snapshot: async () => null
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

  /* TEST 24 - the agent is told what is taken and what is free, and the two never overlap. */
  {
    const test = harness();
    humanApply(test.store, box("left", 0, 0, 300, 200), box("right", 600, 0, 300, 200));
    const view = test.session.inspect("all");
    const occupied = view.occupied as Array<{ id: string; bounds: Bounds; label: string | null }>;
    assert.deepEqual(occupied.map((unit) => unit.id).sort(), ["left", "right"], "every drawn thing is one occupied unit");
    const free = view.freeRegions as Bounds[];
    assert.ok(free.length > 0, "and the empty parts of the board are named");
    for (const region of free) for (const unit of occupied) {
      assert.equal(boundsOverlapArea(region, unit.bounds), 0, "a free region never overlaps something that is taken");
    }
    const needed = test.session.inspect("all", "summary", undefined, { width: 300, height: 200 });
    const origin = needed.suggestedOrigin as { x: number; y: number };
    const target = { minX: origin.x, minY: origin.y, maxX: origin.x + 300, maxY: origin.y + 200 };
    for (const unit of occupied) assert.equal(boundsOverlapArea(target, unit.bounds), 0, "the suggested origin is somewhere the new block actually fits");
  }

  /* TEST 25 - a batch aimed at occupied canvas is refused whole, and says how to get out of it. */
  {
    const test = harness();
    humanApply(test.store, box("diagram", 0, 0, 400, 300));
    test.session.submit({ promptText: "Add a card", instructionInk: [] });
    const lease = await claim(test);
    const before = test.store.document.elements.length;
    const refused = await test.session.apply([{ type: "create_note", id: "on-top", x: 200, y: 150, width: 260, height: 160, text: "Landing on the drawing" }], undefined, lease.leaseToken);
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "placement_collision");
    assert.deepEqual(refused.ids, ["diagram"], "the answer names what is in the way");
    assert.equal(test.store.document.elements.length, before, "and nothing at all was drawn");
    const shift = refused.suggestedTranslation as { dx: number; dy: number };
    const moved = await test.session.apply([{ type: "create_note", id: "on-top", x: 200 + shift.dx, y: 150 + shift.dy, width: 260, height: 160, text: "Beside it instead" }], undefined, lease.leaseToken);
    assert.equal(moved.ok, true, "following suggestedTranslation lands in free space");

    /* Clearing the way in the same call is allowed: the check reads the batch, not just the board. */
    const cleared = await test.session.apply([
      { type: "translate", ids: ["diagram"], dx: 0, dy: -900 },
      { type: "create_note", id: "in-the-freed-space", x: 20, y: 20, width: 240, height: 140, text: "Where the drawing used to be" }
    ], undefined, lease.leaseToken);
    assert.equal(cleared.ok, true, "moving the existing element aside first is accepted");
  }

  /* TEST 26 - SVG path data becomes real geometry inside the box it was given. */
  {
    const test = harness();
    test.session.submit({ promptText: "Draw a wave", instructionInk: [] });
    const lease = await claim(test);
    const applied = await test.session.apply([{ type: "create_path", id: "wave", d: "M 0 50 C 25 0 75 100 100 50 A 20 20 0 0 1 140 50", x: 400, y: 300, width: 200, height: 100 }], undefined, lease.leaseToken);
    assert.equal(applied.ok, true);
    const drawn = test.store.document.elements.filter((element) => element.id.startsWith("wave-"));
    assert.equal(drawn.length, 1, "one subpath becomes one editable element");
    assert.deepEqual(applied.createdIds, ["wave-0"], "and preflight predicted its id");
    const bounds = elementBounds(drawn[0]);
    assert.ok(bounds.minX >= 399 && bounds.maxX <= 601 && bounds.minY >= 299 && bounds.maxY <= 401, "the curve lands inside the box it was fitted to");
    assert.ok(drawn[0].type === "shape" && drawn[0].points.length > 20, "curves and arcs are sampled, not straightened");
  }

  /* TEST 27 - every symbol and every annotation creates exactly the ids preflight promises. */
  {
    const test = harness();
    test.session.submit({ promptText: "Symbols", instructionInk: [] });
    const lease = await claim(test);
    let cursor = 0;
    for (const name of iconNames) {
      const operation: CanvasOperation = { type: "create_icon", id: "icon-" + name, name, x: cursor, y: -400, size: 40 };
      const applied = await test.session.apply([operation], undefined, lease.leaseToken);
      assert.equal(applied.ok, true, name + " draws");
      assert.deepEqual(applied.createdIds, plannedElementIds(operation), name + " creates exactly the ids preflight predicted");
      cursor += 200;
    }
    for (const [index, kind] of annotationKinds.entries()) {
      const operation: CanvasOperation = { type: "create_annotation", id: "note-" + kind, kind, x: index * 400, y: 400, width: 220, height: 160, text: kind + " label" };
      const applied = await test.session.apply([operation], undefined, lease.leaseToken);
      assert.equal(applied.ok, true, kind + " draws");
      assert.deepEqual(applied.createdIds, plannedElementIds(operation), kind + " creates exactly the ids preflight predicted");
      const shape = test.store.document.elements.find((element) => element.id === (kind === "bubble" ? "note-" + kind + "-box" : "note-" + kind));
      assert.ok(shape && shape.type === "shape" && shape.points.length > 3, kind + " has real geometry");
    }
  }

  /* TEST 28 - the human keeps the board beside the proposal, and a rollback spares their work. */
  {
    const test = harness();
    humanApply(test.store, box("existing", 0, 0, 200, 160));
    test.session.submit({ promptText: "Add a panel", instructionInk: [] });
    const lease = await claim(test);
    await test.session.apply([
      { type: "create_note", id: "panel", x: 900, y: 0, width: 260, height: 180, text: "Agent panel" },
      { type: "translate", ids: ["existing"], dx: 0, dy: 40 }
    ], undefined, lease.leaseToken);

    assert.ok(test.session.agentRegion(), "while the agent writes it owns the patch it drew in");
    assert.equal(test.session.canHumanMutateAt({ minX: 950, minY: 20, maxX: 1000, maxY: 60 }), false, "the human may not draw inside it");
    assert.equal(test.session.canHumanMutateAt({ minX: -600, minY: -600, maxX: -500, maxY: -500 }), true, "but anywhere else the board is still theirs");
    assert.equal(test.session.canHumanMutateBoard(), false, "whole-document actions stay locked");

    // The human draws beside the proposal while it is still open.
    humanApply(test.store, { type: "create_stroke", id: "parallel", points: [point(-600, -600), point(-500, -500)] });
    test.session.complete("Panel added", lease.leaseToken);
    assert.equal(test.session.reject(), true);

    const ids = test.store.document.elements.map((element) => element.id);
    assert.equal(ids.includes("panel-card"), false, "rejecting removes what the agent drew");
    assert.ok(ids.includes("parallel"), "and leaves the stroke the human drew beside it");
    const restored = test.store.document.elements.find((element) => element.id === "existing")!;
    assert.equal(elementBounds(restored).minY, 0, "an element the agent moved goes back where it was");
  }

  /* TEST 29 - with automatic acceptance on, a finished turn is simply part of the board. */
  {
    const test = harness();
    test.store.document.settings.autoAcceptAgent = true;
    test.session.submit({ promptText: "Sketch it", instructionInk: [] });
    const lease = await claim(test);
    await test.session.apply([{ type: "create_note", id: "kept", x: 0, y: 0, width: 240, height: 140, text: "Kept without asking" }], undefined, lease.leaseToken);
    const done = test.session.complete("Done", lease.leaseToken);
    assert.equal(done.autoAccepted, true);
    assert.equal(done.awaitingHumanDecision, false);
    assert.equal(test.session.state(), "complete", "there is no review step to sit in");
    assert.equal(test.session.canHumanMutateBoard(), true, "so the human is never locked out waiting to click accept");
    assert.ok(test.store.document.elements.some((element) => element.id === "kept-card"));
    assert.equal(test.store.undo(), true);
    assert.equal(test.store.document.elements.some((element) => element.id === "kept-card"), false, "and one undo takes the whole proposal back");
  }

  /* TEST 30 - a symbol the agent draws once can be stamped by name, in the same call. */
  {
    const test = harness();
    test.session.submit({ promptText: "Draw a valve", instructionInk: [] });
    const lease = await claim(test);
    const define: CanvasOperation = { type: "define_symbol", name: "valve", d: "M 0 0 L 40 20 L 0 40 Z M 80 0 L 40 20 L 80 40 Z" };
    const stamp: CanvasOperation = { type: "create_icon", id: "v1", name: "valve", x: 0, y: 0, size: 60 };
    const applied = await test.session.apply([define, stamp], undefined, lease.leaseToken);
    assert.equal(applied.ok, true, "defining and stamping in one batch is allowed");
    assert.deepEqual(applied.createdIds, plannedElementIds(stamp, { valve: define.type === "define_symbol" ? define.d : "" }), "the stamped symbol creates exactly the predicted ids");
    assert.deepEqual(Object.keys(test.store.document.symbols ?? {}), ["valve"], "and the symbol is kept on the board");

    const again = await test.session.apply([{ type: "create_icon", id: "v2", name: "valve", x: 400, y: 0, size: 60 }], undefined, lease.leaseToken);
    assert.equal(again.ok, true, "a later call can stamp it without redefining it");
    assert.equal((test.session.inspect("all").symbols as string[])[0], "valve", "and inspect lists what there is to stamp");

    const drawn = test.store.document.elements.filter((element) => element.id.startsWith("v1-"));
    assert.ok(drawn.length >= 2 && drawn.every((element) => element.type === "shape"), "the symbol is ordinary editable geometry");
    const box = boardBounds(drawn)!;
    assert.ok(box.maxX - box.minX <= 61 && box.maxY - box.minY <= 61, "and it is scaled into the size it was asked for");
  }

  /* TEST 31 - a name nobody defined is refused, and a built-in name cannot be taken over. */
  {
    const test = harness();
    test.session.submit({ promptText: "Symbols", instructionInk: [] });
    const lease = await claim(test);
    const before = test.store.document.elements.length;
    const refused = await test.session.apply([{ type: "create_icon", id: "ghost", name: "flux-capacitor", x: 0, y: 0 }], undefined, lease.leaseToken);
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "unknown_symbol");
    assert.deepEqual(refused.names, ["flux-capacitor"], "the answer names what could not be found");
    assert.ok((refused.availableSymbols as string[]).includes("server"), "and says what can be stamped instead");
    assert.equal(test.store.document.elements.length, before, "nothing was drawn");
    assert.equal(isCanvasOperation({ type: "define_symbol", name: "server", d: "M 0 0 L 1 1" }), false, "a built-in name cannot be redefined");
  }

  /* TEST 32 - a rejected proposal takes its symbol definition back with it. */
  {
    const test = harness();
    test.session.submit({ promptText: "Define", instructionInk: [] });
    const lease = await claim(test);
    await test.session.apply([
      { type: "define_symbol", name: "cog-wheel", d: "M 0 0 L 30 0 L 30 30 L 0 30 Z" },
      { type: "create_icon", id: "c1", name: "cog-wheel", x: 0, y: 0, size: 40 }
    ], undefined, lease.leaseToken);
    assert.deepEqual(Object.keys(test.store.document.symbols ?? {}), ["cog-wheel"]);
    test.session.complete("Defined", lease.leaseToken);
    assert.equal(test.session.reject(), true);
    assert.deepEqual(Object.keys(test.store.document.symbols ?? {}), [], "the definition goes with the proposal");
    assert.equal(test.store.document.elements.some((element) => element.id.startsWith("c1-")), false);

    /* And a kept one survives being saved and loaded again. */
    const kept = migrateBoard(JSON.parse(JSON.stringify({ ...test.store.document, symbols: { arrowhead: "M 0 0 L 1 1" }, presentation: { sequenceId: "s", index: 2 } })));
    assert.deepEqual(Object.keys(kept?.symbols ?? {}), ["arrowhead"], "symbols survive a round trip through storage");
    assert.equal(kept?.presentation?.index, 2, "and so does the walkthrough step");
  }

  /* TEST 33 - the clean style reaches both what is drawn and what is measured. */
  {
    const test = harness();
    test.store.document.settings.cleanStyle = true;
    test.session.submit({ promptText: "Explain", instructionInk: [] });
    const lease = await claim(test);
    const composed = await test.session.compose({ kind: "flowchart", id: "flow", title: "Release",
      nodes: [{ id: "build", label: "Build the thing" }, { id: "ship", label: "Ship it to everyone" }],
      edges: [{ fromId: "build", toId: "ship" }] }, undefined, lease.leaseToken);
    assert.equal(composed.ok, true);
    const texts = test.store.document.elements.filter((element): element is Extract<PageElement, { type: "text" }> => element.type === "text");
    assert.ok(texts.length > 0 && texts.every((text) => text.fontFamily === "sans"), "clean style writes in plain type");
    assert.ok(test.store.document.elements.every((element) => element.renderStyle !== "sketch"), "and draws straight lines");
    assert.deepEqual(lintBoard(test.store.document).filter((issue) => issue.code === "overlap"), [], "measured in the same face it renders in, so nothing collides");
    for (const text of texts) {
      const card = test.store.document.elements.find((element) => element.type === "shape" && element.semanticRole !== "artboard" && elementBounds(element).minX <= elementBounds(text).minX && elementBounds(element).maxX >= elementBounds(text).maxX);
      if (card) assert.ok(elementBounds(card).maxY + 1 >= elementBounds(text).maxY, `"${text.text}" stays inside its card`);
    }
  }

  /* TEST 34 - flipping the switch restyles the agent's work and spares the human's. */
  {
    const test = harness();
    humanApply(test.store, { type: "create_text", id: "mine", x: -600, y: -600, width: 200, text: "My own note", fontSize: 20 });
    test.session.submit({ promptText: "Add a card", instructionInk: [] });
    const lease = await claim(test);
    await test.session.apply([{ type: "create_note", id: "card", x: 0, y: 0, width: 220, text: "Something the agent wrote that runs over more than one line" }], undefined, lease.leaseToken);
    test.session.complete("Added", lease.leaseToken);
    assert.equal(test.session.accept(), true);

    const label = () => test.store.document.elements.find((element) => element.id === "card-text") as Extract<PageElement, { type: "text" }>;
    const cardShape = () => test.store.document.elements.find((element) => element.id === "card-card")!;
    assert.equal(label().fontFamily, "handwriting", "the agent writes by hand until the switch is flipped");

    test.store.document.settings.cleanStyle = true;
    test.store.restyleAgentContent();
    test.store.changed();

    const restyled = label();
    assert.equal(restyled.fontFamily, "sans", "the agent's writing follows the setting");
    assert.equal(restyled.renderStyle, "clean");
    assert.ok(elementBounds(cardShape()).maxY + 1 >= elementBounds(restyled).maxY, "and the card grew with the text instead of cutting it off");
    const mine = test.store.document.elements.find((element) => element.id === "mine") as Extract<PageElement, { type: "text" }>;
    assert.equal(mine.fontFamily, undefined, "the human's own text is left exactly as it was");
  }

  /* TEST 35 - undo and redo are reachable and say when there is nothing to do. */
  {
    const test = harness();
    assert.equal(test.store.canUndo(), false, "a fresh board has nothing to go back to");
    humanApply(test.store, box("first", 0, 0));
    assert.equal(test.store.canUndo(), true, "after drawing there is");
    assert.equal(test.store.canRedo(), false);
    assert.equal(test.store.undo(), true);
    assert.equal(test.store.canRedo(), true, "and going back makes going forward possible");

    const markup = readFileSync("web/index.html", "utf8");
    const css = readFileSync("web/app.css", "utf8");
    assert.ok(markup.includes('id="undo"') && markup.includes('id="redo"'), "both buttons are in the toolbar");
    assert.equal(/max-width:1420px\)\{[^}]*\.secondary-action\{display:none\}/.test(css), false, "and no breakpoint hides them any more");
    assert.ok(readFileSync("web-src/app.ts", "utf8").includes('byId<HTMLButtonElement>("undo").disabled'), "a button with nothing to undo is disabled, not silent");
  }

  /* TEST 36 - restyling a whole composition leaves every label inside its own card. */
  {
    const test = harness();
    test.session.submit({ promptText: "Deployment", instructionInk: [] });
    const lease = await claim(test);
    await test.session.compose({ kind: "flowchart", id: "flow", title: "Deployment",
      nodes: [{ id: "wait", label: "Auf die Freigabe des ganzen Teams warten" }, { id: "ship", label: "Ausrollen" }],
      edges: [{ fromId: "wait", toId: "ship" }] }, undefined, lease.leaseToken);
    test.session.complete("Composed", lease.leaseToken);
    assert.equal(test.session.accept(), true);

    test.store.document.settings.cleanStyle = true;
    test.store.restyleAgentContent();
    test.store.changed();

    for (const members of Object.values(test.store.document.groups ?? {})) {
      const elements = test.store.document.elements.filter((element) => members.includes(element.id));
      const card = elements.find((element) => element.type === "shape");
      if (!card) continue;
      for (const text of elements.filter((element) => element.type === "text")) {
        assert.ok(elementBounds(text).maxY <= elementBounds(card).maxY + 1, `"${(text as Extract<PageElement, { type: "text" }>).text}" stays inside its card after the restyle`);
      }
    }
    assert.deepEqual(lintBoard(test.store.document).filter((issue) => issue.code === "overlap"), [], "and nothing landed on top of anything else");
  }

  /* TEST 37 - a connector label never sits on the boxes its own arrow connects. */
  {
    const test = harness();
    test.session.submit({ promptText: "Decision", instructionInk: [] });
    const lease = await claim(test);
    await test.session.compose({ kind: "flowchart", id: "flow", title: "Wie ein Cache antwortet",
      nodes: [{ id: "req", label: "Anfrage" }, { id: "hit", label: "Im Cache?", role: "decision" }, { id: "serve", label: "Sofort ausliefern" }, { id: "origin", label: "Vom Ursprung holen" }],
      edges: [{ fromId: "req", toId: "hit" }, { fromId: "hit", toId: "serve", label: "ja" }, { fromId: "hit", toId: "origin", label: "nein" }] }, undefined, lease.leaseToken);

    const labels = ["ja", "nein"].map((text) => test.store.document.elements.find((element) => element.type === "text" && element.text === text)!);
    const cards = test.store.document.elements.filter((element) => element.type === "shape" && element.kind !== "arrow" && element.semanticRole !== "frame");
    // What has to stay clear is the chip the renderer paints, not just the letters inside it.
    const chip = (element: PageElement): Bounds => {
      const box = elementBounds(element);
      return { minX: box.minX - CONNECTOR_LABEL_PADDING.x, minY: box.minY - CONNECTOR_LABEL_PADDING.y, maxX: box.maxX + CONNECTOR_LABEL_PADDING.x, maxY: box.maxY + CONNECTOR_LABEL_PADDING.y };
    };
    for (const label of labels) {
      assert.ok(label.type === "text" && label.width < 60, "a short label claims the width of its word, not a fixed block");
      for (const card of cards) {
        assert.equal(boundsOverlapArea(chip(label), elementBounds(card)), 0,
          `"${label.type === "text" ? label.text : ""}" does not sit on ${card.id}, chip and all`);
      }
    }
    for (const [index, label] of labels.entries()) for (const other of labels.slice(index + 1)) {
      assert.equal(boundsOverlapArea(chip(label), chip(other)), 0, "and two labels do not stack either");
    }
  }

  /* TEST 38 - a card cannot clip the text it was made for, and the lint says so when one does. */
  {
    const test = harness();
    test.session.submit({ promptText: "Cards", instructionInk: [] });
    const lease = await claim(test);
    const long = "Jeder Schreibaufruf braucht das Token des laufenden Zugs. Ohne gueltiges Token wird abgelehnt, und der Agent kann nicht von sich aus loslegen.";
    await test.session.apply([{ type: "create_note", id: "cramped", x: 0, y: 0, width: 300, height: 90, text: long }], undefined, lease.leaseToken);

    const card = test.store.document.elements.find((element) => element.id === "cramped-card")!;
    const label = test.store.document.elements.find((element) => element.id === "cramped-text")!;
    assert.ok(elementBounds(card).maxY - elementBounds(card).minY > 90, "an asked-for height is a minimum, not a lid");
    assert.ok(elementBounds(label).maxY <= elementBounds(card).maxY + 2, "so the label fits inside its card");
    assert.deepEqual(lintBoard(test.store.document).filter((issue) => issue.code === "spills-card"), [], "and there is nothing to report");

    // Shrink the card by hand: now the label sticks out, and that has to be reported.
    if (card.type === "shape") card.points = [{ x: 0, y: 0, pressure: .5 }, { x: 300, y: 70, pressure: .5 }];
    const spills = lintBoard(test.store.document).filter((issue) => issue.code === "spills-card");
    assert.equal(spills.length, 1, "a label hanging out of its card is a defect the lint names");
    assert.deepEqual(spills[0].elementIds, ["cramped-text", "cramped-card"]);
    assert.match(spills[0].suggestedFix, /fit_to_content/, "and it says how to fix it");
  }

  /* TEST 39 - something clipping the edge of a word is reported, a label inside its box is not. */
  {
    const test = harness();
    humanApply(test.store,
      { type: "create_text", id: "heading", x: 0, y: 0, width: 300, text: "1 - Die Seite meldet ihre Werkzeuge an", fontSize: 24 },
      { type: "create_shape", id: "icon", kind: "rectangle", x: 20, y: 40, width: 54, height: 54 });
    const clipped = lintBoard(test.store.document).filter((issue) => issue.code === "overlap");
    assert.equal(clipped.length, 1, "a shape sitting on the last line of a heading is flagged");

    const clean = harness();
    humanApply(clean.store,
      { type: "create_shape", id: "button", kind: "rectangle", x: 0, y: 0, width: 200, height: 60, filled: true, fillColor: "#ffffff", fillOpacity: 1 },
      { type: "create_text", id: "button-label", x: 20, y: 18, width: 160, text: "Weiter", fontSize: 18 });
    assert.deepEqual(lintBoard(clean.store.document).filter((issue) => issue.code === "overlap"), [], "but a label inside its own button is a pattern, not a defect");
  }

  /* TEST 40 - stepping back from the overview starts the walkthrough, it does not jump to the end. */
  {
    const app = readFileSync("web-src/app.ts", "utf8");
    assert.ok(app.includes("const index = current ? Math.max(0, Math.min(sequence.steps.length - 1, current.index + delta)) : 0;"),
      "both arrows enter a walkthrough at step one");
    assert.equal(/delta < 0 \? sequence\.steps\.length - 1/.test(app), false, "and nothing jumps to the last step from the overview");
  }

  /* TEST 41 - a note nobody picks up can be taken back, so the bar is not a one-way door. */
  {
    const test = harness();
    humanApply(test.store, box("a", 0, 0));
    assert.equal(test.session.canWithdraw(), false, "there is nothing to take back before sending");

    assert.equal(test.session.submit({ promptText: "Draw", instructionInk: [] }).ok, true);
    assert.equal(test.session.state(), "queued", "the note waits for an agent");
    assert.equal(test.session.submit({ promptText: "Again", instructionInk: [] }).ok, false, "and a second note is refused while it waits");
    assert.equal(test.session.canWithdraw(), true);
    assert.equal(test.session.withdraw(), true);
    assert.equal(test.session.state(), "idle", "taking it back frees the bar");
    assert.equal(test.session.submit({ promptText: "Again", instructionInk: [] }).ok, true, "so the next note goes through");

    // Once an agent holds the turn the note is no longer the human's to pull away.
    await claim(test);
    assert.equal(test.session.canWithdraw(), false);
    assert.equal(test.session.withdraw(), false, "a turn already being worked on cannot be withdrawn");

    const app = readFileSync("web-src/app.ts", "utf8");
    assert.ok(app.includes("withdraw.hidden = !this.collaboration.canWithdraw()"), "the button shows exactly while there is something to take back");
    assert.ok(readFileSync("web/index.html", "utf8").includes('id="withdraw-turn"'), "and it exists in the prompt bar");
  }

  /* TEST 42 - a full browser store is reported, not thrown out of the middle of a drawing. */
  {
    const test = harness();
    let reported: boolean | null = null;
    test.store.onStorageChange = (working) => { reported = working; };
    let repaints = 0;
    test.store.addEventListener("change", () => { repaints += 1; });

    const real = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { ...real, setItem: () => { throw new Error("QuotaExceededError"); } } });
    humanApply(test.store, box("kept", 0, 0));
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: real });

    assert.equal(reported, false, "the human is told once that saving stopped working");
    assert.ok(repaints > 0, "the canvas is still told to repaint");
    assert.ok(test.store.document.elements.some((element) => element.id === "kept"), "and the drawing survives in memory");

    humanApply(test.store, box("later", 400, 0));
    assert.equal(reported, true, "when saving works again, that is said too");
  }

  /* TEST 43 - a tool that breaks answers with a refusal instead of rejecting the call. */
  {
    const registered: Record<string, (input: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }>> = {};
    Object.defineProperty(globalThis, "document", { configurable: true, value: { modelContext: { registerTool: (tool: { name: string; execute: (input: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text?: string }> }> }) => { registered[tool.name] = tool.execute; } } } });
    await registerWhiteboardTools({
      session: () => ({}), waitForTurn: async () => ({}),
      inspect: () => { throw new Error("the page fell over"); },
      focus: () => ({}), publishPlan: () => ({}), apply: async () => ({}), compose: async () => ({}), complete: () => ({}), snapshot: async () => null
    }, new AbortController().signal);

    const answer = await registered.inspect_whiteboard({});
    const payload = JSON.parse(answer.content[0].text ?? "{}");
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "tool_failed", "the agent gets a refusal it can read");
    assert.match(String(payload.message), /fell over/, "including what actually went wrong");
    assert.match(String(payload.instruction), /Nothing was applied/, "and the assurance that nothing happened");
  }

  /* TEST 44 - two tabs: content follows, an open turn is never pulled away. */
  {
    storage.clear();
    const first = new BoardStore();
    const second = new BoardStore();
    let blocked = 0;
    second.onRemoteBlocked = () => { blocked += 1; };

    first.applyOperation(box("from-the-other-tab", 0, 0), "human");
    first.changed();
    await sleep(60);
    assert.ok(second.document.elements.some((element) => element.id === "from-the-other-tab"), "the other tab picks the drawing up");
    assert.equal(blocked, 0);

    // Now the second tab has a turn open: nothing may be adopted underneath it.
    const session = new CollaborationSession(second);
    session.submit({ promptText: "Mine", instructionInk: [] });
    first.applyOperation(box("later", 600, 0), "human");
    first.changed();
    await sleep(60);
    assert.equal(second.document.elements.some((element) => element.id === "later"), false, "an open turn is not overwritten from elsewhere");
    assert.equal(blocked, 1, "and the human is told once");
    assert.ok(second.document.turn, "the turn itself survives");
  }

  /* TEST 45 - a kept contribution is remembered, a rejected one leaves nothing. */
  {
    const test = harness();
    test.session.submit({ promptText: "Draw", instructionInk: [] });
    const lease = await claim(test);
    await test.session.apply([{ type: "create_note", id: "kept", x: 0, y: 0, width: 220, text: "Kept" }], undefined, lease.leaseToken);
    test.session.complete("Drew the first panel", lease.leaseToken);
    assert.equal(test.session.accept(), true);
    assert.equal((test.store.document.journal ?? []).length, 1, "an accepted turn is one line of history");
    assert.equal(test.store.document.journal![0].summary, "Drew the first panel");
    assert.deepEqual((test.session.inspect("all").history as Array<{ summary: string }>).map((entry) => entry.summary), ["Drew the first panel"], "and the agent can read it back");

    test.session.submit({ promptText: "More", instructionInk: [] });
    const second = await claim(test);
    await test.session.apply([{ type: "create_note", id: "dropped", x: 600, y: 0, width: 220, text: "Dropped" }], undefined, second.leaseToken);
    test.session.complete("Drew a second panel", second.leaseToken);
    assert.equal(test.session.reject(), true);
    assert.equal((test.store.document.journal ?? []).length, 1, "a rejected turn is not part of the story");
  }

  /* TEST 46 - history is capped by weight, so one photo does not fill it. */
  {
    storage.clear();
    const store = new BoardStore();
    const heavy = "data:image/png;base64," + "A".repeat(3_000_000);
    store.document.elements.push({ type: "image", id: "photo", x: 0, y: 0, width: 400, height: 300, dataUrl: heavy, mimeType: "image/png" });
    for (let step = 0; step < 20; step += 1) store.checkpoint();
    let steps = 0; while (store.canUndo()) { store.undo(); steps += 1; }
    assert.ok(steps < 20, `a heavy board keeps fewer steps than the count limit, kept ${steps}`);
    assert.ok(steps >= 1, "but never loses the ability to go back at all");
  }

  /* TEST 47 - a batch may not stack itself, but overlapping shapes stay a way to draw. */
  {
    const test = harness();
    test.session.submit({ promptText: "Notes", instructionInk: [] });
    const lease = await claim(test);

    const before = test.store.document.elements.length;
    const stacked = await test.session.apply([
      { type: "create_note", id: "z1", x: 0, y: 0, width: 240, text: "First" },
      { type: "create_note", id: "z2", x: 20, y: 30, width: 240, text: "Second" },
      { type: "create_note", id: "z3", x: 40, y: 60, width: 240, text: "Third" }
    ], undefined, lease.leaseToken);
    assert.equal(stacked.ok, false);
    assert.equal(stacked.error, "batch_overlap", "notes dropped on each other in one call are refused");
    assert.equal(test.store.document.elements.length, before, "and nothing was drawn");
    assert.match(String(stacked.instruction), /0 and 1/, "the answer names which two operations clash");

    const venn = await test.session.apply([
      { type: "create_shape", id: "v1", kind: "ellipse", x: 0, y: 0, width: 220, height: 220, filled: true, fillColor: "#2457e6", fillOpacity: .25 },
      { type: "create_shape", id: "v2", kind: "ellipse", x: 140, y: 0, width: 220, height: 220, filled: true, fillColor: "#16833b", fillOpacity: .25 }
    ], undefined, lease.leaseToken);
    assert.equal(venn.ok, true, "two overlapping circles are a Venn diagram, not a mistake");

    const spaced = await test.session.apply([
      { type: "create_note", id: "n1", x: 0, y: 600, width: 240, text: "First" },
      { type: "create_note", id: "n2", x: 320, y: 600, width: 240, text: "Second" }
    ], undefined, lease.leaseToken);
    assert.equal(spaced.ok, true, "and notes side by side are fine");
  }

  /* TEST 48 - stacked notes are reported: a sticky note is not scenery. */
  {
    const test = harness();
    humanApply(test.store,
      { type: "create_note", id: "a", x: 0, y: 0, width: 240, text: "First" },
      { type: "create_note", id: "b", x: 30, y: 40, width: 240, text: "Second" });
    const overlaps = lintBoard(test.store.document).filter((issue) => issue.code === "overlap");
    assert.ok(overlaps.length >= 1, "two notes on the same spot are a defect the lint names");

    // A frame is scenery: content is meant to sit on it, and that must stay quiet.
    const framed = harness();
    humanApply(framed.store,
      { type: "create_frame", id: "board", x: 0, y: 0, width: 600, height: 400, title: "Column" },
      { type: "create_note", id: "inside", x: 40, y: 90, width: 240, text: "A card on the board" });
    assert.deepEqual(lintBoard(framed.store.document).filter((issue) => issue.code === "overlap"), [], "a card inside its frame is the point of a frame");
  }

  /* TEST 49 - a rejected operation says which one and what kind it was. */
  {
    const test = harness();
    test.session.submit({ promptText: "Broken", instructionInk: [] });
    const lease = await claim(test);
    const refused = await test.session.apply([
      { type: "create_note", id: "fine", x: 0, y: 0, width: 240, text: "Fine" },
      { type: "set_explanation_sequence", sequence: { id: "x", title: "X", steps: [] } }
    ] as unknown as CanvasOperation[], undefined, lease.leaseToken);
    assert.equal(refused.error, "invalid_operations");
    assert.equal(refused.operationIndex, 1, "it points at the operation that is wrong");
    assert.equal(refused.operationType, "set_explanation_sequence", "and says what kind it was");
    assert.equal(/keep every coordinate finite\. Nothing was applied\.$/.test(String(refused.instruction)), false, "not the old catch-all sentence");
  }

  /* TEST 50 - dragging a text sideways re-wraps it; the letters keep their size. */
  {
    const text: Extract<PageElement, { type: "text" }> = {
      type: "text", id: "wide", x: 0, baseline: 40, width: 200, height: 0, fontSize: 20, color: "#080808",
      text: "Ein Satz der breit genug ist um auf mehrere Zeilen zu laufen wenn das Feld schmal bleibt"
    };
    text.height = estimateTextHeight(text.text, text.width, text.fontSize, text);
    const narrow = { width: text.width, height: text.height, fontSize: text.fontSize };

    reflowText(text, 620);
    assert.equal(text.width, 620, "the width follows the handle");
    assert.equal(text.fontSize, narrow.fontSize, "and the letters stay the size they were");
    assert.ok(text.height < narrow.height, "wider means fewer lines, so it gets shorter");
    assert.equal(text.height, estimateTextHeight(text.text, 620, text.fontSize, text), "the height is measured, not guessed");

    reflowText(text, 5);
    assert.ok(text.width >= 40, "a text cannot be dragged to nothing");

    // Left-hand handles move the origin as well, so the right edge stays put.
    reflowText(text, 300, -120);
    assert.equal(text.x, -120);
  }

  /* TEST 51 - the wiring the text field needs, in the places a browser check cannot reach. */
  {
    const app = readFileSync("web-src/app.ts", "utf8");
    assert.ok(/const editable = hit\?\.type === "text" && !hit\.locked \? hit : undefined;/.test(app),
      "clicking words already on the board opens them instead of starting an empty field on top");
    assert.ok(app.includes("if (existing) input.setSelectionRange(input.value.length, input.value.length); else input.select();"),
      "and the caret lands at the end, so the first keystroke does not wipe the text");
    assert.ok(app.includes('input.addEventListener("input", grow)'), "the field grows with what is written in it");
    assert.ok(/sideOnly && single\?\.type === "text"/.test(app), "a single text pulled by a side handle re-wraps");

    const css = readFileSync("web/app.css", "utf8");
    const shellRules = css.match(/\.text-editor-shell\{[^}]*\}/g) ?? [];
    assert.ok(shellRules.length >= 2, "the editor still has its plain-field override");
    assert.equal(shellRules.some((rule) => rule.includes("overflow:visible")), false,
      "nothing sets overflow to visible: without clipping the browser draws no resize grip and resize:both is dead");
    assert.ok(shellRules.some((rule) => rule.includes("resize:both")), "and the grip is still asked for");
  }

  /* TEST 52 - a screen element can be designed, not just placed. */
  {
    const test = harness();
    test.session.submit({ promptText: "Screen", instructionInk: [] });
    const lease = await claim(test);
    const composed = await test.session.compose({ kind: "ui_mockup", id: "screen", title: "Discover", x: 0, y: 0, width: 440,
      theme: { background: "#ffffff", surface: "#f4f4f5", text: "#111111", accent: "#a3260c" },
      nodes: [
        { id: "bar", label: "Deliver to Hauptstrasse 12", role: "header", fill: "#16171a", fontWeight: 600 },
        { id: "search", label: "Search restaurants", role: "input", width: 380, height: 56 },
        { id: "photo", label: "Pizzeria Napoli", role: "image", width: 380, height: 124 },
        { id: "name", label: "Pizzeria Napoli", role: "text", width: 250, fontSize: 24, fontWeight: 700 },
        { id: "time", label: "25 min", role: "chip", width: 110, height: 40, fill: "#0f7a3d" },
        { id: "price", label: "9,90 EUR", role: "price", width: 110, height: 44, fill: "#fdeee4", radius: 6 }
      ] }, undefined, lease.leaseToken);
    assert.equal(composed.ok, true);
    const byId = new Map(test.store.document.elements.map((element) => [element.id, element]));

    const bar = byId.get("screen-bar") as Extract<PageElement, { type: "shape" }>;
    assert.equal(bar.fillColor, "#16171a", "an element keeps the background it asked for, not the theme's");
    const barLabel = byId.get("screen-bar-label") as Extract<PageElement, { type: "text" }>;
    assert.equal(barLabel.color, "#ffffff", "light type is chosen for a dark ground on its own");
    assert.equal(barLabel.onFilledSurface, true, "and it says it sits on a surface, so the ink guard leaves it alone");

    const search = byId.get("screen-search") as Extract<PageElement, { type: "shape" }>;
    assert.equal(search.kind, "rectangle", "a search field is a rounded field, not an ellipse");
    assert.ok((search.radius ?? 0) > 0, "with rounded corners");

    const chip = byId.get("screen-time") as Extract<PageElement, { type: "shape" }>;
    assert.equal(chip.fillColor, "#0f7a3d");
    const chipBox = elementBounds(chip);
    assert.ok(Math.abs((chip.radius ?? 0) - (chipBox.maxY - chipBox.minY) / 2) < 1, "a chip is a pill: its corners follow its own height");

    const price = byId.get("screen-price") as Extract<PageElement, { type: "shape" }>;
    assert.equal(price.radius, 6, "a radius that was asked for is the radius it gets");

    const name = byId.get("screen-name-label") as Extract<PageElement, { type: "text" }>;
    assert.equal(name.fontSize, 24, "a restaurant name is as large as it was asked to be");
    assert.equal(name.fontWeight, 700);

    assert.ok(byId.has("screen-photo"), "an image placeholder exists");
    assert.ok(test.store.document.elements.some((element) => element.id.startsWith("screen-photo-cross")), "and it is crossed, so nobody takes it for a real picture");

    assert.deepEqual(lintBoard(test.store.document).filter((issue) => issue.code === "overlap" || issue.code === "spills-card"), [],
      "and a designed screen still lays out cleanly");
    const frame = elementBounds(byId.get("screen-screen-border")!);
    assert.equal(Math.round(frame.maxX - frame.minX), 440, "the phone stays the width it was asked for");
  }

  /* TEST 53 - a composition with a self-loop is not blocked by the batch-overlap guard. */
  {
    const test = harness();
    test.session.submit({ promptText: "HTTP", instructionInk: [] });
    const lease = await claim(test);
    // The self-message (server talks to itself) puts a label near another label; that is the
    // composer's own layout, not a hand-placed collision, so it must go through.
    const composed = await test.session.compose({ kind: "sequence", id: "http", title: "How HTTP works",
      nodes: [{ id: "browser", label: "Browser" }, { id: "server", label: "Server" }],
      edges: [
        { fromId: "browser", toId: "server", label: "GET /index.html" },
        { fromId: "server", toId: "server", label: "look the page up" },
        { fromId: "server", toId: "browser", label: "200 OK + HTML" }
      ] }, undefined, lease.leaseToken);
    assert.equal(composed.ok, true, "a sequence with a self-loop composes instead of being refused");
    assert.notEqual(composed.error, "batch_overlap", "the batch-overlap guard does not fire on the composer's own output");
    assert.ok(test.store.document.elements.some((element) => element.type === "text" && element.text.includes("look the page up")), "the self-message is drawn");

    // The guard still fires on a batch the agent assembled itself.
    const stacked = await test.session.apply([
      { type: "create_note", id: "z1", x: 2000, y: 0, width: 240, text: "First" },
      { type: "create_note", id: "z2", x: 2020, y: 30, width: 240, text: "Second" }
    ], undefined, lease.leaseToken);
    assert.equal(stacked.error, "batch_overlap", "a hand-placed stack is still caught");
  }

  console.log("collaboration tests: ok");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
