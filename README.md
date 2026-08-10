# LumiDraw Studio 0.49.0

Includes 0.42.4 through 0.48.0.

## The elf was mine, not the model's

Your prompt is what solved it. Two blocks, same phrase, different words:

```
caption:  Price wraps a towel around elf in the bathroom.
tag run:  ..., wrapping towel around self, ...
```

The tag kept it. The caption didn't. So this was never the text encoder finding
`elf` inside "herself" — **LumiDraw wrote the word.** I reproduced it in one run:

```
Ilsa wraps a towel around elf in the bathroom.
```

### `groundCreatureWords()`

The creature grounder turns a coined creature name into one the model knows —
`mycewolf` → `wolf`. The rule was "ends with a creature noun and is longer than it".

That's a fine rule for a made-up name and a terrible one for English. I checked it
against a 234,000-word dictionary: **it mangles 1,222 real words.**

| you write | model receives |
|---|---|
| herself, himself, myself, itself | elf |
| shape, escape, landscape, drape | ape |
| growl, prowl | owl |
| combat, acrobat | bat |
| program, diagram | ram |
| forbear, forebear | bear |

"The shape of the landscape" has been reaching Draw Things as "the ape of the ape".
It never showed in a log, because the caption just reads slightly wrong and looks
like a parser mistake.

### The fix

No dictionary ships with the extension, so I stopped applying a name-shaped rule to
prose. **A coinage is grounded in a sentence only when the scene itself names it** —
as a subject's label, ref, appearance or outfit. Hyphenated words (`spore-wolf`) are
coinages by construction and need no corroboration.

That's stricter than any blocklist, and it needs no word list:

- *"the alpha mycewolf"* still grounds, because a subject is labelled `alpha mycewolf`.
- *"wraps a towel around herself"* doesn't, because nothing in the scene is a herself.

Tags and labels keep the loose rule — they're name-shaped by construction and
conventionally lowercase, so the corroboration signal isn't there. They're guarded by
a stoplist instead, which is safe because tag vocabulary is narrow.

### One regression, caught by your own test

My first attempt used capitalisation as the signal. `wolfregress` stayed green but
`traits` went red on *"the alpha mycewolf"* — lowercase, and it must still ground.
That's the test you and I built after the wolf fight doing its job.

## Also in here: the reflexive strip

Before I found the real cause I'd built `stripSubwordTraps()`, which removes
reflexive pronouns from the finished prompt. I've kept it, because the token risk is
real independently — "shelf" carries `elf` too and can't be removed. It's cheap:
"braces herself against the table" and "braces against the table" are the same
picture.

And `elf, pointy ears` now goes in the negative whenever nobody in the scene is an
elf, with the check covering `half-elf` and `elven` so a real elf is never negated.

**40 suites · 1242 assertions · all green** — a new `subword` suite, plus 16 more in
`traits` covering the words that made Fanny an elf.
