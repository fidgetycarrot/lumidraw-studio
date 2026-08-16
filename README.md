# LumiDraw Studio 0.88.0 — how many pictures

> "Something about the rules will typically make it gen the max amount instead of
> logically choosing how many important moments."

You were right, and the compiler said it out loud. From its schema:

> `minImages` **is a FLOOR: find that many distinct visual moments EVEN WHEN ONE
> DOMINATES** — a second character's reaction, a change of position, a detail
> shown close.

That's not "use your judgement." That's an instruction to **manufacture**
moments, with suggestions for how to pad. Of course it hit the number.

## And direct mode was no better

It said **nothing at all** about how many. I never passed the count into the
instruction, so the model saw an array in the format and guessed. Not a design
decision — an omission I'd have found the first time you counted.

## The rule now

> Return ONE image. Most passages have one moment worth drawing, and one good
> picture beats two where the second is filler. Add a second ONLY if the passage
> genuinely contains another distinct moment — a different place, a different
> pair of people, a real change of situation — not a second angle on the same
> beat. Never more than 2. **The limit is a ceiling, not a target.**

One is the default. Your maximum is a ceiling. The reason is given, so it reads
as judgement rather than a quota to satisfy — and there's an assertion that
nothing in it says *floor*, *at least*, or *find that many*.

Set your maximum to 1 and it says so plainly instead.

## Note on your minimum

Direct mode ignores the **Minimum images** setting entirely, and I think that's
right — a minimum is what caused this. If you disagree, it's easy to honour, but
I'd rather it not exist than have it quietly recreate the floor.

**58 suites · 2,574 assertions · all green.**
