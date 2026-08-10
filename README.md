# LumiDraw Studio 0.45.0

Includes 0.42.4 through 0.44.0.

## First: do not put "uncensored" in the negative prompt

That would ask for the opposite. `uncensored` is a positive Danbooru tag — it marks
posts where genitals are shown plainly. Putting it in the negative pushes the model
toward the censored half of its training.

The tags that belong in a negative are the censorship ones: `censored`,
`mosaic censoring`, `bar censor`, `heart censor`, `novelty censor`, `steam censor`,
`light censor`, `convenient censoring`.

You don't need to add either by hand — LumiDraw does it now.

## Why a correct prompt still came out censored

Censorship on Danbooru is **tagged**, so the model learned it as a style rather than
as an absence. `futanari` is the worst case: that tag is dense with Japanese
commercial art, where mosaic and bar censoring are a legal requirement. So
`futanari` carries a censorship prior all on its own, and nothing in an ordinary
prompt argues against it.

Adding `penis` cleared it by accident — explicit anatomy tags co-occur with
`uncensored` in the training data far more than with `censored`. You found the right
lever by the wrong route. Saying it directly is more reliable.

**New censorship defence.** When an explicit or nsfw scene shows saved anatomy,
`uncensored` goes into the header beside the safety tag, and the whole censor family
goes into the negative.

```
✓ censorship defence — "uncensored" added and the censor tags negated
```

## Why the anatomy tag wasn't there in the first place

This is the part your instinct was right about, though I've done it in the compiler
rather than in the parser.

The gate required the passage to **name** the anatomy:

```js
anatomyExplicitlyMentioned(profile.anatomy, sourcePassage, ...)
```

A shower scene is nude, but the prose says water and steam — it almost never says
"penis". So the gate stayed shut, the model got a nude figure with nothing anchoring
the genitals, and it filled the gap from the censored end of its training. That is
your mosaic.

A nude body in an nsfw scene shows its anatomy; that is what nude means. The gate
now opens on **either** the passage naming it **or** the subject being stated nude
in an nsfw scene.

```
✓ anatomy gate · Sovi — the passage never names the anatomy, but the subject is
  nude in an nsfw scene, so it is visible
```

### Why not tell the parser, as you suggested

Because the firewall exists precisely because the parser invented anatomy — it wrote
`erect penis` into a walk-on's appearance, and 0.43.0 had to widen the scrub to catch
`erection`, `bulge` and `shaft` doing the same. Telling it "add anatomy when nsfw"
re-opens that door, and it would hand an LLM a decision that has a deterministic
answer. LumiDraw still supplies only what the profile saved.

**Nudity must be stated** — by the outfit, appearance, pose or action. An empty
outfit list is a parser omission at least as often as a naked character, and guessing
wrong puts genitals in a clothed scene. `nude`, `naked`, `completely nude`,
`unclothed`, `undressed`, `bottomless`, `bathing` all count.

## If it recurs

The trace now distinguishes the two failures. `anatomy gate` tells you whether the
tag was allowed; `censorship defence` tells you whether the mosaic was argued
against. Previously both were invisible.

`anatomy.mjs` is up to 75 assertions. **38 suites · 1087 assertions · all green.**
