# Walkthrough: driving the board as the agent

Ten tasks a demo would actually show, worked through the WebMCP tools and logged as they went. The
point was never to prove the tools work — it was to find where reaching for them goes wrong.

**The honest caveat first.** I wrote this implementation, so I am not a naive reader of my own tool
descriptions. That is the known weakness of this method, and it makes the *successes* here worth
little. What is worth something is the places where the reflex still went wrong despite knowing the
code, and the two defects that fell out of it — those would have gone unnoticed either way.

## What happened

| # | Task | First reach | Outcome |
|---|------|-------------|---------|
| 1 | Explain a password login | `create_structured_visual` `kind: "sequence"` | Worked. 8 repairs reported, no lint issues. |
| 2 | Plan the next three months | `create_structured_visual` `kind: "roadmap"` | Worked first try. |
| 3 | Add the failure case to the login | `apply_whiteboard_changes` at coordinates I picked | **Refused** — `placement_collision`. See below. |
| 4 | Draw an actual key, not a box | `create_path` with `d` | Worked. Arcs and lines became five editable pieces. |
| 5 | Turn it into a symbol, stamp it three times | `define_symbol` → `create_icon` ×3 | Worked. |
| 6 | Brace two steps together and say why | `create_annotation` `kind: "brace"` | Worked, but see friction below. |
| 7 | Clean up three notes the human left in a heap | `create_note` ×3, then `auto_layout` | **The heap was accepted.** See finding 1 and 2. |
| 8 | Walk me through the explanation | `set_explanation_sequence` + `present_step` | Worked. An empty step list gave a useless message — finding 3. |
| 9 | Fit something large onto a crowded board | `inspect { needed }` → `comparison` with `x`/`y` | Worked, no collision. |
| 10 | Fix my own wrong label | `inspect` → `update_text` | Worked. |

## Finding 1 — a batch could stack itself

Three sticky notes placed 20 and 30 pixels apart **in one call** were accepted without a word. The
placement check only ever compared the batch against what was already on the board, never against
itself. So the one thing that reliably makes a board unreadable — content on content — was prevented
between calls and waved through inside one.

Fixed: the check now also compares the batch's own blocks. Only things that carry words are judged
(`create_text`, `create_note`, `create_table`, `create_frame`); overlapping *shapes* stay legal,
because that is how a Venn diagram, a stack or a shadow is drawn, and refusing those would take away
a real way to draw. Verified both ways: the three notes are now refused with the operation indices,
two overlapping ellipses still go through.

## Finding 2 — the lint was blind to exactly this

Worse: even after the heap landed, `lintIssues` was empty. `"note"` was listed in `CONTAINER_ROLES`,
the set of things treated as scenery that other content is *expected* to sit on. A sticky note is not
scenery — nothing is meant to sit on a sticky note. That one word switched off overlap reporting for
the most common element an agent creates.

Fixed by removing it. The stricter check immediately failed the torture fixtures, which is the part
worth reporting: **the kanban composition had been drawing its column title on top of the first card
in every column with a long name.** It shipped that way, and the blind spot is why nobody saw it. The
column header is now measured from the title that actually renders instead of a fixed 64 pixels.

## Finding 3 — "does not match the schema" said nothing

`set_explanation_sequence` with an empty `steps` array came back as:

> Use the operation schema exactly and keep every coordinate finite. Nothing was applied.

There are no coordinates in that operation. The message is a catch-all that names neither the
operation nor anything about it. It now reads:

> Operation 0 "set_explanation_sequence" does not match the schema: a required field is missing, has
> the wrong type, or a number is not finite. Check that operation against the schema; nothing was
> applied.

Still not field-level — `isCanvasOperation` returns a boolean and giving it a reason per field is a
larger change — but it names which operation and which type, which is the difference between
guessing and looking.

## Friction that was not a defect

**Task 3: the reflex is to pick coordinates.** `inspect_whiteboard`'s description already says to ask
for a free region first. I reached for `apply` with my own numbers anyway, and the refusal put me
right in one step — it named what was in the way and handed back a free origin. The protocol worked
exactly as designed; the description just was not where I was looking. `apply_whiteboard_changes` now
says it too, in its own text.

**Task 6: a brace has to be aimed by hand.** To bracket two steps I had to read both elements out of
`inspect`, compute the union of their bounds, add margins and pass a box. That is arithmetic the
board could do from two element ids. Not fixed — it is a new feature, not a defect, and it is written
down here rather than quietly added.

## What this did not test

A different model. Every call here was mine, and I have read the source. Whether a model coming to
these eight tools cold picks `create_structured_visual` over forty hand-placed operations, or reads
`occupied` before drawing, is still unmeasured — the largest open assumption in the project.
