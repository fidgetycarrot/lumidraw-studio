# LumiDraw Studio 0.74.0 — all ten, and three places the spec was wrong

Everything on the list is in. Three of them the existing tests pushed back on, and
in each case the tests were right.

---

## Diagnostics first

**Seeds.** Every image now records a real one. A seed Draw Things picks invisibly
is a seed you can never reuse — "reuse seed" had nothing to reuse, and a CFG
sweep was a reroll rather than a paired comparison.

**CFG guard.** Every defence in the compiler is written into the *negative*
prompt. At CFG 1 they're decoration. The log now says so rather than letting you
debug a defence that can't fire.

**History keeps the evidence.** The compile trace and parsed scene are stored with
the image that produced them, and `HISTORY_LIMIT` goes 24 → 80. Every diagnosis
this project got wrong was made by reading code and guessing what the app did.
This is also the end of `LAST_DIAGNOSTIC` being a single slot — a multi-image
re-parse no longer overwrites its own evidence.

## The friendly fire

`pants, trousers` in the negative while Jason wore joggers. `worn.has(rival)`
couldn't see the conflict because the word "pants" never appears in "joggers." At
CFG 1 that's a shrug; at CFG 3 it's a knife.

The zones now know the modern vocabulary, and the bottom family isn't negated
while someone's wearing bottoms.

**Where the spec was wrong:** it counted a *full*-body garment as bottoms too.
`props.mjs` caught it — a dress covers the legs, but nobody in the frame is
wearing pants, so negating pants contradicts nothing and is exactly what the
dress defence is *for*. Including `'full'` disarmed a defence that works. It's
`'bottom'` only.

## The image quality changes

**Relation budget 2 → 3.** The first relation is the body arrangement by design,
so a budget of two left one slot for everything the bodies were actually doing.
The carry got amputated.

**Core action.** Suppression keyed off *any* cross-subject relation existing — so
a relation about where people stand deleted the act. It now requires a relation
whose verb actually matches.

**Where the spec was wrong again:** letting it through exposed that the core
action was never checked against the vocabulary. `replay.mjs` caught it —
`"crouches low, claws extended, facing the alpha wolf"` is three phrases, none of
them tags, and all three went straight into the tag run. It's partitioned now
like everything else: what resolves is kept, what doesn't goes to the caption.

**Geometry tags.** `princess carry`, `straddling`, `hug`, `sitting on lap` — real
Danbooru tags for arrangements the caption could only describe in prose.

**Safety floor.** Underwear as the only bottom layer is not a "safe" image. The
label drives the safety tag, the censorship defence and half the anatomy gating,
so one step too low quietly disabled all three. Only ever raises.

**Bulge.** Nothing said what a body with penis anatomy looks like under a single
layer. Three conditions required, and it reads as a with-trait rather than a build
modifier.

## "The corin"

A capitalized anchor is a name. `named` only gets set when the parser is
confident, which it isn't for someone the story introduced in passing — but the
capital letter is evidence the author already gave us.

## Two things worth flagging

**The instruction budget was at 10,094 of 10,100.** A six-character margin isn't
a margin; whatever I added next was going to break it. I trimmed real redundancy
(phrases saying the same thing twice) rather than shaving to fit, so there's
about 30 characters of room now — and a test that fails at 10,085 rather than
10,100, so the squeeze gets caught early.

**A mutation exposed my own decorative tests.** Deleting `...geometryTags` from
the tag run passed every geometry assertion I'd written — the table existed, the
trace fired, and the tags went nowhere. Source patterns prove the code *says* the
right thing. There are now behavioural tests that compile a scene and read the
actual tag run for geometry, outdoors, bulge and the core action. The same
mutation now fails four.

## Verification

**56 suites · 2,272 assertions · all green.** 75 new in `cfgbatch.mjs`.

Mutation-tested seven ways, all caught: seed made optional (6 failures), the
friendly-fire guard removed (1), capitalized anchors back to descriptions (3),
geometry tags cut from the run (4 — after the behavioural tests, 0 before), the
bulge block deleted (6), outdoors never added (2), core action unfiltered (1).

## Try it

The two you'll see immediately are the seed in the history entry and the CFG
warning in the log. If the warning fires, that's the answer to why a negative
looked ignored.

## Still open

The **0.60.0 `AWAY_RELATION_RE` revert** for the merged subjects.
