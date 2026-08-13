# LumiDraw Studio 0.65.0 — the settings rail

Release 4 of 4. Smaller than I intended, and I want to be straight about why.

## What changed

**Settings is no longer a flat scroll of five unrelated cards.** It has a rail:

```
[ Connection ]  [ Parser ]  [ Advanced ]
```

- **Connection** — Draw Things API, LumiDraw Bridge catalog
- **Parser** — parser connection, model, instruction, budget
- **Advanced** — Draw Things Cloud Compute, Diagnostics

The cloud card no longer sits as prominently as the Draw Things connection you
can't work without. Your section is remembered between sessions.

Two labels also changed: the **Presets** tab is now **Cast & presets**, since it
holds characters, personas and places as well; and *"Last parser result"* is now
*"What the last scan produced"*, because it's output sitting among controls.

The `data-view` value stays `presets` — it's persisted in your browser, so
renaming it would have reset your last tab.

## What I attempted and backed out of

I tried to properly reorganise — move cards between tabs, lift the image-sizing
controls out of "Illustration mode", put the parser output with Diagnostics.

**One block move grabbed the wrong `<div>`.** A help paragraph was carried into a
new card while the checkbox it described stayed behind in another tab. The syntax
check passed. The class counts balanced perfectly — nothing was "lost", it was
just in the wrong place. I only found it because I went looking at the actual
markup afterwards.

So I reverted the whole thing and redid it with **tagging instead of moving**: an
attribute can't separate a control from its label because it never touches
either. That's why this release is a rail and two labels rather than the
reorganisation you asked for.

The honest constraint is that I can't see the UI. For backend logic I can write a
test that proves behaviour; for layout I can only prove structural invariants,
and "this control is under the right heading" is about as far as that goes.

## The test that now exists

`ui.mjs` pins what would have caught the damage:

- **Every control still lives under its own card heading.** My first version of
  this checked that a control and its label stayed within N characters — and a
  mutation that moved *both* into another card passed it cleanly. Proximity was
  the wrong property; card membership is the right one.
- Every control appears exactly once — a duplicate means a block was pasted
  twice, a zero means one was carried off.
- Every view's `<div>`s balance, so a cut mid-block shows up.
- No settings card is left untagged, since an untagged one would vanish the
  moment a section is selected.
- The rail is styled outside a media query — the first attempt put it inside one,
  which would have made it mobile-only.

**51 suites · 1,939 assertions · all green.** Three mutations tried against the
new suite; the one that initially slipped through is the reason the membership
check exists.

## If you want the full reorganisation

It's worth doing, and it wants one of two things:

1. **You tell me where things should go** — I'll move them one card at a time,
   showing you the before/after structure for each, rather than restructuring in
   one pass I can't verify.
2. **Or you let me screenshot it.** With computer use I can open Lumiverse, look
   at the panel, and check my own work — which turns this from guessing into
   seeing.

Option 2 is what I'd pick. Layout is the one area where the feedback loop that's
served us all session — write a test, mutate it, confirm it catches the break —
doesn't really substitute for looking.
