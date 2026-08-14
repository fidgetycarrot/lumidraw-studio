# LumiDraw Studio 0.82.0 — "Fantasy setting" checkbox

## Why 0.81.0 wasn't enough for you

I made the elf defence evidence-based: fire only when the letters `elf` actually
appear in what's being sent, because `shelf` hides them and can't be stripped.

In an isekai chat that's **worse**, not better. Fantasy prose is full of those
letters — shelf, himself, herself, elsewhere — and it's a world where elves are
supposed to exist. The evidence check would fire *more often* there, negating a
species your story might be actively trying to draw.

No regex can work out which kind of story you're in. So it's asked.

## The checkbox

In the Cast panel, under the picker:

> ☐ **Fantasy setting — don't treat elves as a mistake**

Tick it for your isekai chat and `elf, pointy ears` never enters the negative for
that story, whatever the prose contains. Your contemporary chat keeps the guard.

It lives on the **cast** because it's a fact about the story, and the cast is the
per-story object we built in 0.76–0.78. Bind a cast, tick the box, done — it
follows the chat like everything else.

## Verification

**57 suites · 2,460 assertions · all green.**

Mutation-tested two ways, both caught: the flag ignored (2 failures), every story
treated as fantasy (4). The second matters as much as the first — a flag that's
always on is the same as no defence, and 0.81.0's behaviour has to survive for
your other chat.

## Worth saying

This is the fourth defence in two days that was calibrated for one kind of story
and wrong in another — joggers, the facing veto, the blanket elf negative, and
now the setting. The pattern is consistent: I wrote a rule that was true for the
scene in front of me and made it unconditional.

The fantasy flag is the first one that admits the app can't know. If you hit more
of these, that's probably the shape of the fix — a fact about the story, asked
once, rather than another regex trying to infer it.
