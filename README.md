# LumiDraw Studio 1.2.0 — why the characters swap places

Not the image models. Two of these are LumiDraw's fault — the parser broke its
own rules and nothing checked.

## 1. The frame and Elliot were in the same block

Count the BREAKs in that prompt:

```
block 0: 25 tags · count tags: [2girls, 1boy, 1boy]
block 1: 15 tags · count tags: [1girl]
block 2: 16 tags · count tags: [1girl]
```

Three BREAKs, but **none between the shared frame and the first character.** The
scene description and Elliot's entire run are one block — a block that declares
`1boy` twice and announces `2girls` alongside him.

Anima binds a BREAK-delimited block as **one subject group**. So Elliot's
features sit in a block that says there are two girls present, and
`camera facing doorway` / `wide shot` bind to *him* rather than to the camera.
After that the model is guessing, and guessing is what you're seeing.

**Fixed.** The rule needs no judgement: a block may open with count tags — that's
the shared frame — but the first count tag appearing *after* a non-count tag
starts a new subject, and a new subject needs a BREAK. An already-correct prompt
comes through byte-identical.

## 2. Names are not tags

`Elliot`, `Fanny`, `Hannah`. Anima has never heard of them. The direct-mode rules
already say *"NEVER … a character's name as a tag"* — the parser wrote them
anyway and nothing enforced it.

At best a name is noise competing with the description. At worst it pulls toward
whichever booru character happens to share it, which is its own source of
"why does she look wrong".

**Fixed.** Names are matched on the whole tag, never as a substring, so `jason
mask` survives while `Jason` doesn't.

## 3. Three characters — this one I won't fix for you

The rules say **at most two**, and they say it because that's where this model
falls apart. Your prompt has three. That alone would cause swapping even with
the two fixes above.

LumiDraw now warns instead of trimming:

> `3 characters in one image. Anima reliably falls apart past two — expect
> features and positions to swap between them.`

Which character to lose is your call, not mine, and dropping one silently would
be worse than a muddled picture you can see is muddled. If Hannah in the doorway
is the beat, the strongest version is probably her and one other.

## Also worth knowing

Your scene block says `couch` while Elliot is `lying on bed`. The model has to
reconcile two pieces of furniture, and that muddle compounds the positioning
problem. That one's the parser reading the passage, not a structural bug.

## Verification

**62 suites · 2,951 assertions · all green.**

Mutations caught: the fused block left fused (3 failures), names matched as
substrings (1), an anchor that is itself a count tag deleting every count tag (1).

A fifth mutation **blew the stack instead of failing an assertion** — the split
recurses on model output and was unbounded if the guard weakened. That's a crash
pretending to be a caught bug, so the recursion is capped now and there's a test
for forty fused subjects.

One existing assertion also failed on `indexOf` returning -1 after I moved the
line it anchored to. That's the **fourth** time -1 has produced a meaningless
ordering result in this suite, so it now asserts both anchors exist before
comparing them.
