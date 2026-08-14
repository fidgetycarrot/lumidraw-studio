# LumiDraw Studio 0.73.0 — the story's cast belongs to the story

You had it exactly right, and it's the deeper half of the same bug.

`absorbCastDeclarations` writes into `preset.castLibraryIds`. **The preset is
global.** Nothing ever took an entry out again. So the cast of every chat was the
union of the cast of *all* chats, permanently — and 0.72.0 made it worse, because
every refresh press absorbed a whole chat's history into that shared list.

That's why reset couldn't help. There was nothing chat-shaped to reset.

## The line

- **A character you added by hand** in the Characters tab is a deliberate choice.
  You picked them, so they're yours everywhere. Global, unchanged.
- **A character the story invented** belongs to the story that invented it.

`declaredByStory` was already drawing that line — I recorded it in 0.5x with a
comment saying it was "so the Characters tab can show where this came from," and
then **never read it anywhere.** It's now load-bearing.

New declarations record `declaredInChat`. `castMemberBelongsHere` is one named
function, called in one place, and the cast stops leaking.

## The ones already in there

I can't know retroactively which chat declared them. Guessing would be worse than
admitting it, so an unattributed entry keeps appearing in every chat — marked
**(any chat)** — until you remove it. Properly attributed ones show **(story)**.

## Removal, and the rule that makes it safe

Every cast row has an **×** now. What it does depends on which kind it is:

- **Story-declared** → deleted outright. Nothing of yours is in it.
- **One you wrote** → unlinked from this preset only. **Never deleted.** You wrote
  it and I have no business throwing it away.

The confirmation says which before it happens, so the button is never a surprise.
The main character and persona have no × — they come from the preset itself and
there'd be nothing to remove them from.

## A test that passed for the wrong reason

`cast.mjs` pinned the old call signature. Adding the chat argument broke it — and
the assertion on the line *below* went on passing:

```js
be.indexOf('absorbCastDeclarations(messages, targetIndex, preset)') < be.indexOf('out-of-character messages')
```

`indexOf` returns **-1** when the string is absent, and -1 is less than
everything. So the ordering check kept confirming the position of something that
no longer existed. That's the same trap I documented earlier in this project and
then walked straight back into. Presence is now asserted separately from position.

## Verification

**55 suites · 2,196 assertions · all green.** 37 new in `wardrobe.mjs`.

Mutation-tested four ways, all caught: chat filter removed (3 failures),
unattributed entries made to vanish (1), removal allowed to delete characters you
wrote (1), new declarations no longer recording their chat (2).

## What to do once

Open the outfits panel in each chat and clear the **(any chat)** rows. After that
the leak is closed going forward — anything a story declares from here on stays
in that story.

## Still open

The **0.60.0 `AWAY_RELATION_RE` revert** for the merged subjects. One line.
