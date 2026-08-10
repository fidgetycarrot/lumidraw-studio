# LumiDraw Studio 0.43.0

Includes 0.42.4 and 0.42.5.

## Penis on a female — what I found

I read the path before changing it. The gate itself looks right, and it may well
have fired correctly on your image. **Anatomy is never a shared tag.** In a
multi-subject prompt it appears only as an owner-bound caption sentence:

> Sovi's penis is visibly exposed.

The caption binds by name. The model binds by proximity — and Anima has seen a
great deal of futanari. A `1girl` standing in a frame where a penis is named can
be given one, and nothing in the prompt said whose body it was not.

Two holes, both fixed.

### 1. Nothing defended the other body

New `anatomyDefence()`, built like the existing garment defence. When an explicit
or nsfw scene has one subject with saved anatomy and another subject who is
counted female and has none, the negative prompt gains:

```
futanari, dickgirl, newhalf, futa
```

Deliberately **not** `penis` — the caption is asking for one on the other subject,
and negating the tag outright is how anatomy disappears from a scene entirely.
That is the opposite failure, and it's already an open note from before.

It stands down when it should: two men, a solo subject, a safe or sensitive
rating, or a woman with her own saved anatomy. It also stands down when the female
subject's own identity blurs this — `futanari`, `trap`, `otoko no ko`, `femboy`,
`cuntboy`, `newhalf`, `intersex`. Negating futanari on a futa is negating who she
is, and Sovi must not be caught by this.

The compile trace reports it either way:

```
✓ anatomy defence — negating futanari, dickgirl, newhalf, futa
· anatomy defence — anatomy is named but no unequipped female subject shares the frame
```

### 2. The firewall had two gaps of its own

**Unprofiled subjects skipped it entirely.** The scrub was inside a ternary that
returned known refs cleaned and everyone else untouched, so an `other_1` walk-on
could be handed anatomy in her pose, outfit or action and nothing stopped it. She
now gets the same scrub; only the appearance wipe stays profile-only, since an
unprofiled subject has no saved appearance to fall back on.

**The pattern was too narrow.** These all read as pose or clothing and sailed
through: `erection`, `erect`, `member`, `manhood`, `shaft`, `girth`, `balls`,
`clitoris`, `clit`, `labia`, `genitalia`, `crotch`, `groin`, `bulge`, `dickgirl`,
`newhalf`. All covered now.

## If it happens again

Two things narrow it immediately, and I would rather have them than guess:

1. **The compile trace** for that image — the `anatomy defence` line says whether
   it fired and why.
2. **Her profile's Anatomy mode.** If it's set to `always` rather than `relevant`,
   the tag is unconditional and no passage gate applies. Worth a look before
   anything else.

New `anatomy.mjs` suite: 50 assertions. **37 suites · 1023 assertions · all green.**
