/*
 * Self-playing demo for the trailer.
 *
 * Paste into the DevTools console on the LIVE bridge (no ?instant — we WANT the live streaming):
 *   https://bertus37987.github.io/smooth-whiteboard-webmcp/bridge.html
 *
 * It plays the whole story ON the real whiteboard, paced for a screen recording:
 *   1. the human types a prompt and sends it
 *   2. the agent claims the turn and draws — live — the very turn protocol it is running on
 *   3. the human points with a follow-up, the agent revises in place
 *   4. the human accepts
 *
 * Everything is real: real tools, real turn, real drawing. Record the tab (Playwright / OBS) while
 * this runs, then cut it snappy. Total on-board action ~45 s.
 */
(async () => {
  const T = window.whiteboardTools;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bar = document.getElementById("instruction-prompt");
  const type = async (text, ms = 45) => { for (let i = 1; i <= text.length; i++) { bar.value = text.slice(0, i); bar.dispatchEvent(new Event("input", { bubbles: true })); await sleep(ms); } };
  window.confirm = () => true;

  // clean slate
  const rej = document.getElementById("undo-agent"); if (rej && !document.querySelector(".review")?.hidden) rej.click();
  const wd = document.getElementById("withdraw-turn"); if (wd && !wd.hidden) wd.click();
  document.getElementById("clear").click();
  await sleep(700);

  // 1 — the human asks
  await type("Explain how WebMCP works");
  await sleep(500);
  document.getElementById("submit-turn").click();

  // 2 — the agent takes the turn
  const L = (await T.json("wait_for_human_turn", { timeoutMs: 5000 })).leaseToken;
  await T.json("publish_agent_plan", { leaseToken: L, summary: "Draw the turn protocol this board runs on." });
  await sleep(500);

  // title first, so the recording has a beat before the diagram builds
  await T.json("apply_whiteboard_changes", { leaseToken: L, operations: [
    { type: "create_text", id: "ttl", x: -560, y: -390, width: 1160, text: "How WebMCP works", fontSize: 50, fontWeight: 700 },
    { type: "create_text", id: "sub", x: -560, y: -322, width: 1300, text: "The page hands a real AI agent real tools — no screenshots, no server.", fontSize: 24 },
  ]});
  await sleep(900);

  // the sequence: one shared turn between the human and the page's agent
  await T.json("create_structured_visual", { leaseToken: L, kind: "sequence", title: "One shared turn", x: -560, y: -250,
    nodes: [{ id: "you", label: "You" }, { id: "agent", label: "This page  +  Agent" }],
    edges: [
      { fromId: "you", toId: "agent", label: "1 · submit — your prompt + AI-pen" },
      { fromId: "agent", toId: "you", label: "2 · wait_for_human_turn → lease" },
      { fromId: "agent", toId: "you", label: "3 · inspect — what's on the board" },
      { fromId: "agent", toId: "you", label: "4 · apply — draws, live" },
      { fromId: "agent", toId: "you", label: "5 · complete — a proposal" },
      { fromId: "you", toId: "agent", label: "6 · Accept  ✓   (or Reject)" },
    ]});
  await sleep(700);

  // the registration callout — the other half of the concept
  const place = await T.json("inspect_whiteboard", { leaseToken: L, needed: { width: 620, height: 150 } });
  const O = place.suggestedOrigin;
  await T.json("apply_whiteboard_changes", { leaseToken: L, operations: [
    { type: "create_note", id: "reg", x: O.x, y: O.y, width: 600, height: 130,
      text: "document.modelContext.registerTool()\nThe page announces its own tools when it loads. A browser agent reads them and calls them — like functions, not pixels." },
  ]});
  await sleep(900);

  // 3 — the agent finishes; the proposal now awaits the human
  await T.json("complete_whiteboard_contribution", { leaseToken: L, summary: "The turn protocol, drawn on the board it runs on." });
  document.getElementById("fit").click();
  await sleep(1400);

  // 4 — the human accepts (the whole point: the human is the gate)
  document.getElementById("accept").click();
  await sleep(600);
  console.log("demo complete — the board explains the very protocol it just used.");
})();
