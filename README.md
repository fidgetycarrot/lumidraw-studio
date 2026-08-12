# LumiDraw Studio 0.60.0 — the truck cab prompt contradicted itself

## The bug

Your prompt contained both of these:

> *Price, chin tipped and eyes on sketchbook, **faces away from** Jason.*

> `... @cherrymousestreet, **face-to-face, facing another**, car interior ...`

The caption says she faces away. The tag run says they're front to front. Anima
resolved it toward the tags, which is why Jason is looking at her instead of at
the road.

## Why

```js
const FACING_RELATION_RE = ... '\\bfac(?:es|ing)\\b' ...          // matches "faces"
const AWAY_RELATION_RE = /...|\bturn(?:s|ing) away\b|.../          // does NOT match "faces away"
```

`FACING_RELATION_RE` matches the bare word **"faces"**, so *"faces away from
Jason"* read as *facing*. The guard that would have suppressed it —
`if (facesEach && !facesAway)` — never fired, because the away list caught
"turns away" but not "faces away".

**The single clearest statement that two people are not front-to-front was the
one phrase that asserted they were.** Same class of bug as `self` → `elf`: a
pattern matching a substring of the word that means the opposite.

## The fix

`AWAY_RELATION_RE` now covers faces/facing away, looks/looked away, turned away,
glances away, averts, "away from", "over her shoulder", and "back turned".

Deliberately wide, because the failure directions aren't symmetric: a suppressed
`face-to-face` costs a composition hint, an asserted one costs the pose the
passage actually described.

## Verification

**44 suites · 1634 assertions · all green**, with 20 new in `facing.mjs`.

Mutation-tested against the original regex — 7 of the new assertions fail with
the old pattern and pass with the new one, so they're testing the fix rather than
describing it. The suite also still requires `face-to-face` to fire for genuine
front-to-front scenes (kissing, staring at, confronting, talking to), so this is
a narrowing rather than a blanket disable.

Also fixed: `cloud.mjs` was reading `lumidraw-cloud-relay.mjs`, which you deleted
during cleanup, and broke the whole run. Relay assertions now skip when the file
is absent instead of taking the suite down.

## What this does NOT fix

**Left/right placement.** Your prompt said *"Price is on the right and Jason is
on the left"* and the image has them swapped. That instruction is prose only —
there's no reliable Danbooru tag for left/right subject placement, so the model
ignores it. Anima has no trained handle for it and I'd be inventing one.

If it matters for a particular image, the honest fix is regenerating with a
different seed until placement lands, rather than more prompt engineering.

**"heels on dashboard"** also didn't land — her legs are up but her feet aren't
on the dash. `feet on dashboard` isn't a well-populated booru tag, so it's a weak
lever regardless.

The cab itself is noticeably better than your earlier ones: mirror, headrests,
windshield and dash are all coherent. The 0.53 framing cap is doing its job.
