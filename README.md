# LumiDraw Studio 0.96.0 — clothing

Your note was the most useful thing you've sent me. Most of that list was **one
sentence**, in the direct-mode rules:

> *"Copy the character sheets EXACTLY for identity **and clothing**. They are the
> author's, not suggestions, and a character must look the same in every image."*

The parser was being **instructed** to override the story's clothing with the
saved outfit, and told a character must never change clothes. That is, straight
off your list: the saved outfit beating the story outfit, old tags drifting into
a new one, and Fanny in Elliot's jeans while the prose has her in harem silks.

**Identity is the author's. Clothing is the story's.** Conflating them was the bug.

## What changed

**The passage always wins.** Identity is still copied exactly — body, hair, eyes,
species. Clothing is now labelled as history:

> `last seen wearing (the passage overrides this): oversized hoodie`

**"Bulge becomes wearing a bulge."** Both true, and both this line — everything in
the outfit record was announced as `wearing: …`, so a body fact that got in there
read as a garment. And `bulge` gets in *by design*; the underwear rule adds it.
Body facts are now reported separately as `body, not clothing:`.

Split by an explicit list, not by "not a known garment" — `garmentZone` returns
empty for `midriff` *and* for `harem silks`, so the lazy version would have filed
your harem silks as anatomy. There's a test.

**Invented trousers.** The parser is now told: a garment nobody mentioned is a
garment nobody is wearing. If someone's in nothing but an oversized shirt, say so
with `no pants` / `bottomless` rather than quietly adding jeans and shoes.

## LUMIWEAR — your idea, and the durable half

> *"Maybe a preset prompt addition for the story model to constantly update
> clothing? I do not want to be responsible for manually updating the LumiDraw
> app with clothing tags. That sounds terrible."*

It would be, and a wardrobe only you can update is wrong within two turns.
LumiCast already proved the shape.

```
[LUMIWEAR]{"name":"Fanny","outfit":"sheer harem silks+gold jewelry+anklet"}[/LUMIWEAR]
```

**`lumiwear-preset-block.md` is in this zip** — paste it in like the LumiCast one.

- **Last declaration wins** (opposite of LumiCast: described once, dressed often).
- **Replaces, never merges** — this is the `midriff` fix.
- An unrecognised name is dropped, not written to a stray row.
- Stripped from the parser's copy, same as LumiCast.

**↻ now reads clothing too.** "Pressing refresh does not change the wardrobe of
record" — it couldn't; refresh only ever absorbed *cast* declarations. Clothing
was never read from the chat at all. It is now, and the panel says who was
re-dressed.

## Not in this release

**Emotions wrong** and **swipe gives no image** — I haven't touched either. The
emotion one I suspect is expression tags binding across a BREAK to the wrong
character, which is the same family as the clothing mix-ups, but I'd rather look
at a prompt where it happened than guess. Send me one.

## Verification

**60 suites · 2,852 assertions · all green.** New suite: `clothes.mjs`, 46.

Mutations caught, all five: the sheet authoritative again (3 failures), body facts
back in the clothing line (2), classifying by "not a known garment" so harem silks
becomes anatomy (2), a declaration merging instead of replacing (3), first
declaration winning instead of last (3).

One existing assertion in `direct.mjs` failed and I **replaced** it rather than
restoring it — it asserted the sheets were authoritative for clothing, which is
precisely the behaviour being removed. The reason is written into the test.
