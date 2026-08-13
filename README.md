# LumiDraw Studio 0.63.0 — Named Looks

Release 2 of 4. Idea from
[kittyafterdark/LumiSwarm-Studio](https://github.com/kittyafterdark/LumiSwarm-Studio).

## What you get

In the character and persona editors, a **Named looks** field:

```
formal = black evening gown, heels | aliases: gala, the gown | no: jeans
swim   = blue bikini | aliases: the pool
```

A Look is applied three ways, in this order:

1. **The parser names it.** It now reports a `look` field per subject.
2. **An alias appears in the prose.** "She smoothed *the gown*" selects `formal`
   with no tagging required.
3. **The default look**, when nothing else applies.

Per-Look **negatives** are scoped to the scenes that Look is active in — *no
jeans while she's in the gown* — and never persisted.

## The design decision you made, and why it matters

You picked **Looks above the wardrobe, not replacing it**. That turns out to hinge
on one word:

> A Look wins at the moment it **becomes** active. An unchanged Look yields to
> the wardrobe.

Both alternatives are worse in ways that are easy to miss:

- If a Look overrode the wardrobe *every* scene, "she kicked off her sneakers"
  would be undone by the very next image, and the entire 0.53–0.56 clothing chain
  — the digest, family correction, zone merging — would become dead weight.
- If it *never* overrode the wardrobe, selecting a Look would do nothing at all
  while a stale record existed, which is exactly the sealed loop 0.56 fixed.

So the precedence is now:

```
this passage  >  a Look that just became active  >  the wardrobe  >  her default
```

Everything you already had still works and still earns its keep.

## Looks are clothes. States are bodies.

Deliberately separate, and enforced. Mixing them is what made appearance states
dangerous in the first place — switching one transforms the whole character. The
parser is told in as many words: *"A look is a set of clothes, not a body. Never
use it for a transformation, a mood, or a place."*

An appearance state with `outfit=omit` — a transformation that has no clothes —
suppresses the Look too.

## Where the guidance went

Straight into the slot 0.62.0 built. `dynamicGuidanceBlocks` gained exactly one
entry and nothing else about instruction assembly changed, which was the point of
building it first. The guidance says nothing at all when nobody in the cast has
Looks, so the instruction budget is spent only when there's something to say.

## Details worth knowing

- **Alias matching is whole-word only.** "dressing-gowns" does not select a Look
  aliased `gown` — the lesson `selectAppearanceState` learned when *werewolf*
  matched a state named *Wolf*.
- **The longest cue wins**, so `heavy coat` beats `coat`.
- **A Look with no outfit is refused loudly** rather than saved. An empty Look
  would silently strip a character when selected, which reads as a compiler bug
  rather than an empty field.
- **Every path is traced** — which Look, why it was chosen, and whether it set
  the outfit or yielded. A character silently in the wrong clothes is the
  recurring failure in this area, and the trace is how it gets diagnosed.
- **A Look is remembered without a grounding check**, unlike an outfit. An outfit
  is inferred from prose and can be wrong; a Look was *chosen*, so there's
  nothing to corroborate — it just needs remembering, so the next scene can tell
  "still in the gown" from "just put the gown on".

## Verification

**49 suites · 1,832 assertions · all green.** 60 new in `looks.mjs`.

Mutation-tested on the three ways the precedence could be wrong: a Look that
overrides every scene, a Look that never overrides, and substring alias matching.
All three caught.

I also deleted one assertion I'd written that was vacuous — it asserted an empty
result from a profile that had no default, so it would have passed no matter what
the code did.

## Next

**Release 3 — Visual Lorebook.** Visual canon for places and objects, which is
the real answer to the truck cab: you've been fixing settings by suppressing what
the model gets wrong, and that fixes them by asserting what a place looks like.
Needs the `world_books` permission, so it'll ask you to re-grant on install.
