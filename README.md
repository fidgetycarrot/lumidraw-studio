# LumiDraw Studio 0.77.0 — casts, part 2 of 3: the binding, and the payoff

Part 1 built the data. This is where it starts doing something.

## The payoff

A character the story invents now goes into **the cast of the story that invented
it.** Not into `preset.castLibraryIds`, which is global and shared by every chat.

That's the whole architecture in one sentence. 0.73.0 could only *filter* a
polluted global list at read time, because the pollution was already in the
preset. With a cast bound there's nothing to filter — it never gets in.

Your original complaint — *"it still shows characters from the old chat"* — is
now structurally impossible rather than defended against.

## Cast — this chat

A new control above the wardrobe, in the Story panel:

- **Pick the cast** this chat uses. Switch chats, the cast follows.
- **Copy** — start a new story from an existing cast without touching the one you
  already have. Editing a shared cast is the dangerous move; copying is cheap.
- A one-line summary of who's actually in it.

## You shouldn't have to touch it

> "Then I would really never have to do anything."

A chat that's never been bound **binds itself** the first time it resolves
people, to the cast that came from the preset it's already using. That isn't a
behaviour change — it's the same people the fallback would have given you — it
just makes them *this chat's* people from then on, so the next story can't
inherit them.

And it binds **once**. If it re-bound on every image, unbinding by hand would be
undone by the next picture.

## The promise still holds

`presets.json` is still byte-identical after migration, after a scan that adopts
two new characters, and after rebinding. That's asserted at the end of part 2,
not just part 1 — the guarantee has to survive the code that came after it.

Your visual preset is now purely visual in practice: changing it no longer
changes who's in the scene.

## Verification

**57 suites · 2,389 assertions · all green.** 96 in `cast2.mjs`.

Mutation-tested four ways: declarations routed back into the shared preset (5
failures), chats never auto-binding (2), auto-bind overriding a manual choice
(3) — and one that **wasn't caught.**

Making the cast duplicate a shallow copy instead of a deep one passed everything.
I checked rather than papering over it: the copy is serialized to JSON before
anything can observe the shared reference, so the aliasing is genuinely
unobservable through the storage boundary. The deep copy stays because it's
correct practice, but I'm not going to claim a test proves it when it can't.

## What's left

**Part 3** — the wardrobe keyed by chat + cast rather than chat + preset, so
switching visual presets stops moving your characters' clothes. Then the cast
fields come out of the preset editor, and the split is complete in the UI as well
as the data.
