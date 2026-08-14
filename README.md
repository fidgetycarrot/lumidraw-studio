# LumiDraw Studio 0.70.0 — clothes can come off now

Three fixes for one bug: **nothing in the compiler had ever read the passage for
clothing being removed.**

The rule is "silence means unchanged", and the wardrobe restores what she was
last seen in. That's right for *"she's still in her jeans"* and wrong in exactly
one direction for *"she pulled her shirt off"* — undressing is narrated as an
**action**, the parser has a perfectly good field for actions, so it writes the
pose and leaves `outfit` empty. Silence. She gets dressed again.

Which is why the failure was always the same way round: **stuck dressed, never
stuck naked**, and obvious in your prose while invisible to the app.

## 1. The compiler reads removal

`undressedZones` reads the passage for what came off:

- *naked, nude, stripped, undressed* → everything
- *pulled her shirt off* → the top zone
- *kicked off her sneakers* → feet
- *shoved her shorts down* → bottom

Deliberately narrow. **"He took her hand"** isn't undressing, **"she pulled on a
clean shirt"** isn't removal, and a garment merely *mentioned* in a neighbouring
sentence isn't taken off — removal is matched per sentence so a cue in one clause
can't claim a garment from another.

A one-piece goes with any zone it covers: a dress can't survive *"he pulled the
dress off her shoulders"* just because the cue named the top half.

## 2. The profile default is suppressed too

This is the part I got wrong on the first pass. Clearing the wardrobe wasn't
enough — the fallback chain just walked on to her **default outfit** and dressed
her again. The undress was being defeated one line below where I'd fixed it.

Removal is now applied to whichever source is selected, so wardrobe *and* default
both lose the garments. And a fully bare subject with nothing reported gets
**`nude` stated** rather than an empty outfit: empty says nothing and lets the
model choose, but the passage said something, so the prompt should too.

## 3. The wardrobe stops eating things that aren't clothes

Your record held **"white shirt in hands"** and **"hickey on collarbone"**.
Neither is worn. The first got in because:

```js
if (GARMENT_RE.test(text)) return false   // sees "shirt", stops looking
```

"in hands" explicitly says it *isn't* being worn, and nothing read that far. Then
`garmentSupported` — *"anything already established is grounded by definition"* —
made it certify itself forever. That's the sealed loop of 0.56 in a different
hat, and it's why the panel was the only cure.

Carried garments (*in hands, over one arm, draped, discarded, on the floor,
clutched*) and skin marks (*hickey, handprint, welt, tan line*) are now checked
**before** the garment word, because the garment word winning is the entire
problem.

## 4. The parser is told, but only when it matters

A block in the dynamic slot, emitted **only when a wardrobe record exists** —
with nothing remembered there's nothing to wrongly restore:

> Silence means unchanged, so an outfit you leave empty means she is still
> dressed. If the passage takes clothing off you MUST report the outfit — "nude",
> "topless", "bottomless", or what remains. Putting the removal in pose or action
> instead will put her clothes back on.

## Still do this once

Clear Fanny's wardrobe line in the panel. The new checks stop *new* pollution;
they don't retroactively clean what's already recorded, and "white shirt in
hands" will keep being restored until it's gone.

## Verification

**53 suites · 2,072 assertions · all green.** 47 new in `undress.mjs`.

Mutation-tested four ways. Two findings worth naming:

- **One mutation "passed" because my escaping never applied it.** Re-run
  properly, it failed. A mutation that doesn't mutate proves nothing, and I only
  noticed by checking the source for the string I thought I'd changed.
- **Another passed because the fix was redundant** — I'd applied removal in two
  places, so deleting one changed nothing. That's the third decorative check I've
  written tonight. There's now exactly one application point, and killing it
  fails four assertions.
