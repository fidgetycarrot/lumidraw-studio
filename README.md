# LumiDraw Studio 0.54.0

Includes 0.42.4 through 0.53.2.

That review is largely right, and its one-sentence version is the correct diagnosis:
**the wardrobe had no honest writer.** I've taken most of it. Below is what I built,
what I skipped, and where it was working from a stale copy.

## The zone bug was real, and worse than described

I reproduced it before touching anything:

```
memory: red dress, sandals | passage reports jeans
  -> {"outfit":["jeans"],"restored":[],"corrected":[]}
```

Jeans and nothing else. Topless with nobody having said so, and the dress gone
rather than merely uncovered. A one-piece is now displaced only when the passage
dressed the **whole** body:

| memory | passage says | result |
|---|---|---|
| red dress | jeans | jeans, **red dress** |
| red dress | blouse | blouse, **red dress** |
| red dress | blouse + skirt | blouse, skirt *(dress displaced)* |

The residual oddity is real — dress + jeans is incoherent but covered, and by the
same asymmetry as everywhere else, covered-and-odd beats half-dressed.

**Also found while testing it:** `corset`, `bustier`, `halter`, `turtleneck`,
`sweatshirt`, `waistcoat` had no zone at all, so they covered nothing and a
remembered top was layered over them. Zoned now.

## The parser's contract changed

Not just "here's the wardrobe" — the field itself now means something different:

> Attire is kept for you. **OMIT** a subject's outfit array entirely when the
> CURRENT PASSAGE does not change it — silence means unchanged. Fill it in only
> when the passage changes, removes or adds clothing, or when a time-skip means
> they would have changed. When you do, give the **whole** outfit, not the one
> garment the passage mentioned.

This is the review's best point. It turns a reported outfit from noise into a
signal: it now means *this changed*, which is what makes the memory write
trustworthy. It costs no instruction budget because it lives in the wardrobe block,
which only appears when there is a wardrobe — so a first scene still gets described.

The outfit cap went **3 → 6**. A real outfit is 4–6 items and memory was being
truncated before it ever saw the whole thing.

## Learning is now separate from rendering

The passage still wins for the image. But an ungrounded garment is no longer
written to memory — which matters more since 0.53.2, because the re-wording
correction now *defends* whatever got learned:

```
[lumidraw] outfit memory · character — rendered but NOT remembered, nothing in
the passage backs them: sundress
[lumidraw] outfit memory · character — learned: denim shorts, t-shirt
```

Same shape as `settingTagSupported`, same asymmetry as the OOC gate: not learning a
real garment costs one restore, learning a false one poisons every later image.

One bug in my own first cut, worth recording: `normalizeIdentityText` strips
hyphens, so `t-shirt` reduces to head `shirt` — my synonym table keyed on `t-shirt`
and silently blocked every tee. Canonicals are bare head nouns now.

## Anonymous refs no longer carry a wardrobe

`other_1` is a position, not a person. The tavern keeper in scene 1 and the bandit
in scene 8 are the same ref, so the keeper's apron was being restored onto the
bandit. Skipped on both read and write. Named refs keep theirs.

## What I did not build, and why

**LUMIWARDROBE.** It's the right long-term answer — the review is correct that the
wardrobe should track the story rather than the images. But LUMICAST is a preset
mechanism you haven't tested yet, and shipping a second one that depends on the same
unproven cooperation would mean two things failing at once with no way to tell which.
Worth doing once LUMICAST is known to work.

**The `stripBorrowedOutfit` ownership change.** Plausible, but it's the function that
stops garments bleeding between characters in two-handers, and rewriting it on
reasoning alone is how I'd introduce the bug it exists to prevent. It deserves its
own investigation with a failing case.

**Inline protocol injection.** You're on the Anima parser; inline isn't your path.

## One correction to the review

It says the parser can't see the wardrobe. That was true when it was written —
0.53.2 fixed it an hour ago. What it *added* on top, and what I've now taken, is the
omit-unless-changed contract, which is the more valuable half.

**42 suites · 1412 assertions · all green.**
