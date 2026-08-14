# LumiDraw Studio 0.78.0 — casts, part 3 of 3: the split is complete

## The last piece of the conflation

Scene memory was keyed `chatId::presetName`. So **changing your model moved your
characters' clothes** — the visual settings were acting as an identity for what
people are wearing.

That's now keyed by the cast. Switch presets, try a different LoRA, change your
steps — the wardrobe stays exactly where it was, because none of that has
anything to do with who's in the story or what they're wearing.

## Nothing recorded is stranded

Re-keying is the operation that could quietly orphan every outfit you've built
up. The old preset-keyed entry is **copied** to the cast key the first time it's
asked for, and deliberately left where it was. Same rule as parts 1 and 2, for
the same reason: if the new key turns out wrong, the old one still has your data.

Read and write resolve the scope through the same function — because a save going
to one key while the read comes from another is exactly the shape of the bug you
reported at the start of all this.

## Characters have moved (but nothing was deleted)

The preset editor now says so, in a note above the profile fields:

> **Characters have moved.** Who is in a story is now a cast, set per chat in the
> Story tab — so changing this preset no longer changes who is in the scene or
> what they are wearing. The two profiles below still work and are still the
> fallback for a chat with no cast bound. Nothing here has been deleted or
> altered.

The blocks are **collapsed and labelled**, not removed. Deleting live data from
the UI while it's still the fallback is how people lose things, and you told me
what mattered to you.

## What you should see now

Set a cast in a chat once. From then on:

- Switch chats → the cast follows.
- Switch visual presets → nothing about your people changes.
- The story introduces someone → they join *that* chat's cast, and no other.
- The wardrobe is per cast, so two stories with the same characters keep separate
  clothes.

Which is what you described: *"the visual is set, I change chats and the cast is
set, I never have to do anything."*

## Verification

**57 suites · 2,413 assertions · all green.** 120 in `cast2.mjs`.

Mutation-tested four ways this part, all caught: old wardrobe entries stranded (2
failures), the carry moving instead of copying (1), saving writing to a different
key than reading (1), the wardrobe reverting to preset-keyed (1).

Across all three parts: **12 mutations, 11 caught.** The one that escaped was the
shallow-copy duplicate in part 2, and I checked rather than assumed — it's
unobservable because serialization breaks the aliasing before anything can see it.

## The promise, asserted at the end

`presets.json` is byte-identical after: the migration, a scan that adopts new
characters, a hand-edited wardrobe, and duplicating a cast. Plus
`presets_backup_pre_cast.json` untouched from before any of it, and the original
scene-memory entries still readable.

Three releases in, nothing of yours has been deleted or rewritten.
