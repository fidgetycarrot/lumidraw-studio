# LumiDraw Studio 0.75.0 — the facing veto was firing on furniture

The one I'd been offering for four rounds. Here's what it actually was.

`face-to-face` and `facing another` aren't only orientation hints. They're two of
the strongest statements in the whole prompt that **there are two separate
bodies** — on Danbooru they overwhelmingly tag images of two distinct figures.

0.60.0 widened the veto list to fix a real bug ("faces away from Jason" was
coming out as face-to-face), and I wrote in the file:

> Over-matching here is the safe direction: a suppressed face-to-face costs a
> composition hint, an asserted one costs the pose the passage described.

That was wrong. A suppressed face-to-face doesn't cost "a composition hint" — it
removes the clearest thing the prompt says about there being two people. And bare
`behind` matches a counter, a light, a table.

## What it was doing

Same relation each time, only the sentence changed:

```
face-to-face, facing another  Price and Jason face each other in the kitchen.
— NOTHING —                   Price faces Jason, the counter behind her.
— NOTHING —                   Price faces Jason with light behind them.
— NOTHING —                   Price faces Jason and steps away from the door.
— NOTHING —                   Price faces Jason, standing behind the table.
```

In prose full of furniture, those tags have been vanishing constantly.

## The change

`behind` now needs a **person** on both sides — a person verb before it, and not
a piece of scenery after. `away from` needs a person after it. Everything that
genuinely means "these two are not front-to-front" still vetoes:

| still suppresses | no longer suppresses |
|---|---|
| takes her **from behind** | the counter **behind her** |
| **stands behind** Jason | **standing behind** the table |
| **faces away** from Jason | light **behind** them |
| **turns away** from him | steps **away from the** door |
| **steps away from** Jason | moving **away from the** wall |
| back is turned, over her shoulder | |

The 0.60.0 bug stays fixed — that's asserted separately, because giving it back
while fixing this would be the obvious way to make things worse.

## Two things the tests caught

- **"presses" and "crouches" take `-es`, not `-s`.** My verb pattern missed both.
- **"standing behind the table" is the same scenery problem one level down** — I
  fixed `away from` for scenery and then wrote `behind` without the same guard.
  The test failed on exactly that sentence.

## Verification

**56 suites · 2,292 assertions · all green.** 22 new.

Mutation-tested three ways, all caught: bare `behind` restored (4 failures),
`away from` loosened back to scenery (3), person-behind-person no longer vetoing
(3).

## Now go measure it

You have seeds. Take a two-character scene, generate on 0.66 and on 0.75 at the
same seed, and look. That's the first time this has been answerable by anything
other than me guessing at code.

If the merging is still there, this wasn't the cause and I'll say so.
