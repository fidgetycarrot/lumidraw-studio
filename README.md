# LumiDraw Studio 1.3.36 — composition tags

Instruction-only, as agreed. No schema change, no serializer change. Your
`frontend.js` is byte-identical to your upload.

## What was wrong

One line of the parser instruction:

> `"act" must be exactly one of: fellatio, cunnilingus, handjob, vaginal, anal,
> masturbation. Do not invent another term. **Vaginal includes cowgirl,
> missionary, doggystyle, and mating press**`

Four different body arrangements — four compositions, four camera relationships —
collapsed into one token before the prompt was ever built. And
`normalizeGroupAct` drops anything outside that set, so a parser that *did* say
`missionary` lost the entire interaction to `unrecognized act`.

The category error underneath: Danbooru treats **act** and **position** as
independent axes. Act is what is happening; position is how the bodies are
arranged. One field was doing both jobs, and the collision was resolved by
discarding position — the half that actually tells the model where limbs go.
`vaginal` constrains almost nothing about composition, which is why Anima was
guessing and why you were spending tokens describing around it.

## What changed

**A COMPOSITION section in the instruction.** The tag goes in `prompt` with the
camera tags, early — one tag only, a real one, and *none* if the passage doesn't
support one, because a wrong arrangement is worse than an unstated one.

**The group frame now permits it.** It previously said `"prompt" contains camera,
setting, and lighting tags only` — which excluded composition outright.

**`act` keeps its enum.** It still binds actor to recipient, which is what makes
that field reliable. It just no longer swallows the geometry. The instruction now
states the two are compatible, so the no-repeat rule won't suppress one.

**Six vocabulary additions.** `reverse cowgirl position`, `mating press`,
`spooning`, `standing sex`, `girl on top`, `sitting on lap` — real Danbooru tags
the parser could name and the vocabulary would have rejected. Same hole as the
joggers gap. All thirteen composition tags the instruction offers now resolve
`exact`, and there's a test that walks the instruction's own list to prove it —
so a dead suggestion can't be added later.

## The plumbing already worked

Worth knowing, because it's why this was cheap: a composition tag placed in the
frame `prompt` already survived verbatim into the shared frame, right after the
count tags. I verified that before changing anything. Nothing downstream needed
touching.

## Verification

**`composition.mjs` — 36 assertions.** It checks the tag reaches the frame, lands
*early* (before the first subject), appears exactly once, and never leaks into a
character run — which is how a composition becomes one person's pose while the
other stops participating in it.

Mutations caught: the act line swallowing arrangement again, and the instruction
offering a tag the vocabulary doesn't know.

**One mutation did NOT bite**, and I've left that visible. Reverting the group
frame's permission line broke nothing, because every test injects the tag into
the parser reply directly and so can't check whether the parser was ever *told*
to produce one. Two text assertions now cover those lines. They're weak, and
they're labelled as weak — but the alternative is an instruction line that can be
deleted with no test noticing.

The capture gate is unaffected: **regression.mjs 21/21**.

## Still outstanding

The 13 suites that don't match 1.3.35 yet. Unchanged by this release.

## What to do

Run a scene at a fixed seed, then re-run it with the composition tag removed from
the frame by hand. That's the comparison worth having, and the seed makes it a
real one.
