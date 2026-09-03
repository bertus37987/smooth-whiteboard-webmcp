# Demo- und Test-Skripte

Alle Skripte laufen in der **DevTools-Konsole** auf der Brücken-Seite:
`https://bertus37987.github.io/smooth-whiteboard-webmcp/bridge.html`

Die Brücke stellt `window.whiteboardTools` bereit — das ist der WebMCP-Zugang, den ein echter
Agent hätte. Öffne die Konsole mit F12 → Tab „Console", füge ein Skript ein, Enter.

Jedes Demo-Skript hinterlässt einen **Vorschlag** (gestrichelter Rahmen). Du drückst **Accept**,
dann steht es fest — genau der Mensch-im-Tor-Ablauf.

---

## 0. Verbindungstest — kommt ein getippter Prompt beim Agenten an?

Das ist der ehrliche Test, den die Unit-Tests umgangen haben: Der **Agent wartet zuerst**, und
**du tippst danach** von Hand in die Leiste. Führe das Skript aus, und tippe innerhalb von 8
Sekunden etwas in die Chat-Leiste und drück Senden.

```js
(async () => {
  const T = window.whiteboardTools;
  console.log("Agent wartet … tippe jetzt in die Leiste und drück Senden (8 s).");
  const got = await T.json("wait_for_human_turn", { timeoutMs: 8000 });
  console.log("Empfangen:", got.state, "| Dein Prompt:", got.promptText ?? "(nichts)");
})();
```

Erwartung: `Empfangen: claimed | Dein Prompt: <was du getippt hast>`. Kommt „(nichts)", war die
Leiste blockiert — dann lade neu (der Fix von heute räumt hängende Züge automatisch weg).

---

## 1. Mathematik — quadratische Gleichung Schritt für Schritt

```js
(async () => {
  const T = window.whiteboardTools;
  const s = document.getElementById("instruction-prompt");
  s.value = "Löse eine quadratische Gleichung Schritt für Schritt";
  s.dispatchEvent(new Event("input", { bubbles: true }));
  document.getElementById("submit-turn").click();
  const c = await T.json("wait_for_human_turn", { timeoutMs: 5000 });
  const L = c.leaseToken;
  await T.json("create_structured_visual", { leaseToken: L, kind: "math_steps",
    title: "x² + 5x + 6 = 0 lösen", steps: [
      { expression: "x² + 5x + 6 = 0", note: "Ausgangsgleichung" },
      { expression: "(x + 2)(x + 3) = 0", note: "faktorisieren: 2·3 = 6, 2+3 = 5" },
      { expression: "x + 2 = 0  oder  x + 3 = 0", note: "ein Produkt ist 0, wenn ein Faktor 0 ist" },
      { expression: "x = -2  oder  x = -3", note: "die beiden Lösungen" }
    ] });
  await T.json("complete_whiteboard_contribution", { leaseToken: L, summary: "Quadratische Gleichung gelöst" });
  document.getElementById("fit").click();
  console.log("Fertig — drück Accept.");
})();
```

---

## 2. UI-Layout — zwei App-Screens, sehr zuverlässig

Nutzt die Design-Kontrolle (Farben, Radius, Rollen). Bleibt bewusst simpel, damit es sicher klappt.

```js
(async () => {
  const T = window.whiteboardTools;
  const s = document.getElementById("instruction-prompt");
  s.value = "Entwirf zwei Screens für eine Fitness-App";
  s.dispatchEvent(new Event("input", { bubbles: true }));
  document.getElementById("submit-turn").click();
  const c = await T.json("wait_for_human_turn", { timeoutMs: 5000 });
  const L = c.leaseToken;
  const TH = { background: "#ffffff", surface: "#f4f4f5", text: "#111111", accent: "#0f7a3d" };
  const DUNKEL = "#16171a", GRUEN = "#0f7a3d";
  await T.json("create_structured_visual", { leaseToken: L, kind: "ui_mockup", id: "home",
    title: "1 · Heute", x: 0, y: 0, width: 440, theme: TH, nodes: [
      { id: "kopf", label: "Hallo, Willy", role: "header", fill: DUNKEL, fontWeight: 600 },
      { id: "ring", label: "Tagesziel", role: "image", width: 380, height: 150 },
      { id: "wert", label: "820 / 1000 kcal", role: "text", width: 380, fontSize: 26, fontWeight: 700 },
      { id: "chip1", label: "Lauf", role: "chip", width: 110, height: 40, fill: GRUEN },
      { id: "chip2", label: "Kraft", role: "chip", width: 110, height: 40, fill: GRUEN },
      { id: "start", label: "Training starten", role: "button", width: 380, height: 58, fill: GRUEN },
      { id: "nav", label: "Heute · Verlauf · Profil", role: "navbar", fill: DUNKEL }
    ] });
  await T.json("create_structured_visual", { leaseToken: L, kind: "ui_mockup", id: "run",
    title: "2 · Lauf läuft", x: 540, y: 0, width: 440, theme: TH, nodes: [
      { id: "karte2", label: "Karte", role: "image", width: 380, height: 200 },
      { id: "zeit", label: "24:18", role: "text", width: 380, fontSize: 44, fontWeight: 700 },
      { id: "d", label: "4,2 km · 5:47 /km · 312 kcal", role: "text", width: 380, fontSize: 17 },
      { id: "stop", label: "Pause", role: "button", width: 380, height: 58, fill: "#a3260c" }
    ] });
  await T.json("apply_whiteboard_changes", { leaseToken: L, operations: [
    { type: "connect", id: "f", fromId: "home-screen-border", toId: "run-screen-border", label: "Training starten", strokeWidth: 3 }
  ] });
  await T.json("complete_whiteboard_contribution", { leaseToken: L, summary: "Fitness-App: zwei Screens" });
  document.getElementById("fit").click();
  console.log("Fertig — drück Accept.");
})();
```

---

## 3. Biologie — Fotosynthese als Fluss (sehr zuverlässig)

Flussdiagramme messen sich selbst und überlappen nie — der sicherste Bio-Demo.

```js
(async () => {
  const T = window.whiteboardTools;
  const s = document.getElementById("instruction-prompt");
  s.value = "Erklär, wie Fotosynthese funktioniert";
  s.dispatchEvent(new Event("input", { bubbles: true }));
  document.getElementById("submit-turn").click();
  const c = await T.json("wait_for_human_turn", { timeoutMs: 5000 });
  const L = c.leaseToken;
  await T.json("create_structured_visual", { leaseToken: L, kind: "flowchart", title: "Fotosynthese",
    nodes: [
      { id: "licht", label: "Sonnenlicht", role: "primary" },
      { id: "blatt", label: "Chloroplast im Blatt fängt das Licht" },
      { id: "wasser", label: "Wasser (H₂O) aus den Wurzeln" },
      { id: "co2", label: "CO₂ aus der Luft" },
      { id: "reaktion", label: "Lichtreaktion + Calvin-Zyklus", role: "decision" },
      { id: "zucker", label: "Zucker (C₆H₁₂O₆) — Nahrung" },
      { id: "o2", label: "Sauerstoff (O₂) — Abgabe" }
    ],
    edges: [
      { fromId: "licht", toId: "blatt" },
      { fromId: "blatt", toId: "reaktion" },
      { fromId: "wasser", toId: "reaktion" },
      { fromId: "co2", toId: "reaktion" },
      { fromId: "reaktion", toId: "zucker", label: "baut auf" },
      { fromId: "reaktion", toId: "o2", label: "gibt ab" }
    ] });
  await T.json("complete_whiteboard_contribution", { leaseToken: L, summary: "Fotosynthese als Fluss" });
  document.getElementById("fit").click();
  console.log("Fertig — drück Accept.");
})();
```

---

## 4. Der Wow-Moment — gezeichnete Zelle (SVG-Pfade)

Beeindruckender, aber die Organellen müssen gruppiert werden (sonst meldet der Lint die gewollte
Überlappung mit der Membran). Fertiges, geprüftes Skript:

```js
(async () => {
  const T = window.whiteboardTools;
  const s = document.getElementById("instruction-prompt");
  s.value = "Erklär im Detail, wie eine Zelle funktioniert";
  s.dispatchEvent(new Event("input", { bubbles: true }));
  document.getElementById("submit-turn").click();
  const c = await T.json("wait_for_human_turn", { timeoutMs: 5000 });
  const L = c.leaseToken;
  const A = { kern: "#2457e6", mito: "#16833b", er: "#7c3aed", golgi: "#c2410c", lyso: "#0e7490" };
  const m = (n, x, y, f) => ([
    { type: "create_shape", id: `nr-${n}`, kind: "ellipse", x, y, width: 34, height: 34, color: f, filled: true, fillColor: f, fillOpacity: 1 },
    { type: "create_text", id: `nr-${n}-t`, x, y: y + 5, width: 34, text: String(n), fontSize: 19, fontWeight: 700, textAlign: "center", color: "#ffffff", onFilledSurface: true }
  ]);
  await T.json("apply_whiteboard_changes", { leaseToken: L, operations: [
    { type: "create_text", id: "zt", x: 0, y: -74, width: 700, text: "Wie eine Zelle funktioniert", fontSize: 40, fontWeight: 700 },
    { type: "create_path", id: "membran", d: "M 70 4 C 108 4 136 22 136 50 C 136 78 110 96 70 96 C 32 96 4 78 4 50 C 4 22 34 4 70 4 Z", x: 0, y: 0, width: 640, height: 460, strokeWidth: 3.5, fillColor: "#f4f7ff", fillOpacity: 1 },
    { type: "create_path", id: "kern", d: "M 50 50 m -34 0 a 34 34 0 1 0 68 0 a 34 34 0 1 0 -68 0 M 50 50 m -28 0 a 28 28 0 1 0 56 0 a 28 28 0 1 0 -56 0 M 50 44 m -10 0 a 10 10 0 1 0 20 0 a 10 10 0 1 0 -20 0", x: 80, y: 150, width: 190, height: 190, strokeWidth: 2.4, color: A.kern },
    { type: "create_path", id: "mito", d: "M 8 32 C 8 14 28 6 50 8 C 76 10 96 20 96 34 C 96 50 76 58 50 56 C 26 54 8 46 8 32 Z M 20 28 C 28 36 32 24 40 32 C 48 40 52 28 60 36 C 68 44 72 32 80 38", x: 360, y: 90, width: 210, height: 120, strokeWidth: 2.4, color: A.mito },
    { type: "create_path", id: "golgi", d: "M 12 30 C 32 16 66 16 86 30 M 14 46 C 34 32 66 32 88 46 M 16 62 C 36 48 68 48 90 62", x: 380, y: 250, width: 180, height: 100, strokeWidth: 2.4, color: A.golgi },
    { type: "create_path", id: "lyso", d: "M 50 50 m -40 0 a 40 40 0 1 0 80 0 a 40 40 0 1 0 -80 0", x: 300, y: 360, width: 74, height: 74, strokeWidth: 2.2, color: A.lyso },
    ...m(1, 150, 235, A.kern), ...m(2, 500, 60, A.mito), ...m(4, 540, 300, A.golgi), ...m(5, 300, 330, A.lyso)
  ] });
  const ids = (await T.json("inspect_whiteboard", {})).elements.filter(e => /^(membran|kern|mito|golgi|lyso|nr)-/.test(e.id)).map(e => e.id);
  await T.json("apply_whiteboard_changes", { leaseToken: L, operations: [{ type: "group", groupId: "zelle", ids }] });
  await T.json("apply_whiteboard_changes", { leaseToken: L, operations: [
    { type: "create_text", id: "l1", x: 720, y: 20,  width: 480, text: "1  Zellkern — der Bauplan (DNA), gibt alle Anweisungen", fontSize: 19 },
    { type: "create_text", id: "l2", x: 720, y: 110, width: 480, text: "2  Mitochondrium — das Kraftwerk, macht Energie (ATP)", fontSize: 19 },
    { type: "create_text", id: "l4", x: 720, y: 200, width: 480, text: "4  Golgi-Apparat — die Packstation für Proteine", fontSize: 19 },
    { type: "create_text", id: "l5", x: 720, y: 290, width: 480, text: "5  Lysosom — die Müllabfuhr, recycelt Bausteine", fontSize: 19 }
  ] });
  await T.json("complete_whiteboard_contribution", { leaseToken: L, summary: "Gezeichnete Zelle mit Legende" });
  document.getElementById("fit").click();
  console.log("Fertig — drück Accept.");
})();
```

---

## Zurücksetzen zwischen Demos

```js
(async () => {
  const T = window.whiteboardTools;
  const r = document.getElementById("undo-agent"); if (r) r.click();      // offenen Vorschlag verwerfen
  const w = document.getElementById("withdraw-turn"); if (w && !w.hidden) w.click();  // Zug zurücknehmen
  await new Promise(r => setTimeout(r, 200));
  const alles = (await T.json("inspect_whiteboard", {})).elements.map(e => e.id);
  const s = window.whiteboardTools;  // Board leeren geht über den Papierkorb in der Leiste
  document.getElementById("clear").click();
  console.log("Board zurückgesetzt (Leeren ggf. bestätigen).");
})();
```
