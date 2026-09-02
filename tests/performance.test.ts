import assert from "node:assert/strict";
import { BoardStore } from "../web-src/store";
import { CanvasOperation, lintBoard } from "../web-src/model";
import { occupancyMap, freeRegions } from "../web-src/occupancy";

/* ------------------------------- harness ------------------------------- */

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key)
} });

/**
 * A ceiling, not a benchmark. These numbers are generous on purpose: they are here to catch a
 * tenfold regression — an accidental scan inside a scan — not to defend ten percent. The measured
 * times are printed so a slow change is visible even while it still passes.
 */
// Measured on the machine this was written on: 47 ms, 339 ms, 10 ms, 407 ms. The ceilings sit a few
// times above that, so a slow machine still passes while a real regression does not. Before the
// connector pass got a spatial index, the middle one was 19,907 ms — that is what this is guarding.
const BUDGET = { changed500: 400, changed2000: 2000, lint2000: 400, occupancy2000: 1600 };

function boardOf(cards: number): BoardStore {
  storage.clear();
  const store = new BoardStore();
  const operations: CanvasOperation[] = [];
  const columns = Math.ceil(Math.sqrt(cards));
  for (let index = 0; index < cards; index += 1) {
    const x = (index % columns) * 320; const y = Math.floor(index / columns) * 220;
    operations.push({ type: "create_note", id: `card-${index}`, x, y, width: 240, height: 140, text: `Card ${index}\nA line of detail that has to be measured` });
  }
  // One connector per four cards: connectors are the part that scans the board on every change.
  for (let index = 4; index < cards; index += 4) {
    operations.push({ type: "connect", id: `edge-${index}`, fromId: `card-${index - 4}-card`, toId: `card-${index}-card`, label: `${index}`, route: "orthogonal" });
  }
  for (const operation of operations) store.applyOperation(operation, "agent");
  return store;
}

function millis(label: string, run: () => void): number {
  const started = performance.now();
  run();
  const took = performance.now() - started;
  console.log(`  ${label}: ${took.toFixed(0)} ms`);
  return took;
}

function main(): void {
  {
    const store = boardOf(125);
    const elements = store.document.elements.length;
    assert.ok(elements >= 250, "a 125-card board is a few hundred elements");
    const took = millis(`changed() on ${elements} elements`, () => store.changed());
    assert.ok(took < BUDGET.changed500, `a change on a small board stays under ${BUDGET.changed500} ms, took ${took.toFixed(0)}`);
  }

  {
    const store = boardOf(700);
    const elements = store.document.elements.length;
    assert.ok(elements >= 1400, "a 700-card board is well past a thousand elements");
    const changed = millis(`changed() on ${elements} elements`, () => store.changed());
    assert.ok(changed < BUDGET.changed2000, `a change on a large board stays under ${BUDGET.changed2000} ms, took ${changed.toFixed(0)}`);

    const lint = millis(`lintBoard on ${elements} elements`, () => { lintBoard(store.document); });
    assert.ok(lint < BUDGET.lint2000, `the lint stays under ${BUDGET.lint2000} ms, took ${lint.toFixed(0)}`);

    const occupancy = millis(`occupancy + free regions on ${elements} elements`, () => {
      occupancyMap(store.document.elements, (id) => store.groupIdFor(id) ?? null, undefined, true);
      freeRegions(store.document.elements, undefined, 3);
    });
    assert.ok(occupancy < BUDGET.occupancy2000, `the placement map stays under ${BUDGET.occupancy2000} ms, took ${occupancy.toFixed(0)}`);
  }

  console.log("performance tests: ok");
}

main();
