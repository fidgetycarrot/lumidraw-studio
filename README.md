# LumiDraw Studio 0.48.0

Includes 0.42.4 through 0.47.0.

## Camera is a closed list now

Two halves, because either alone leaves a gap.

### The parser is told the options

The schema said `"camera": ["essential framing tags"]` — an open invitation, which
is why it kept inventing `dynamic angle`. It now gets the actual list:

> **CAMERA** — pick only from this closed list, never invent one; these are the only
> framing words the model was trained on, so "dynamic angle" instructs nothing at all.
> **Frame** (at most one): portrait | upper body | cowboy shot | full body | wide shot.
> **Angle** (at most one): from above | from below | from side | from behind | from front | straight-on | dutch angle.
> **Lens, rarely:** depth of field | foreshortening.
> Two people in contact take cowboy shot; a lone figure in a large space takes wide shot; a reaction takes portrait.

That last line matters. You said you don't know the composition before the image
exists — but the parser does. It has just read the passage and knows whether two
people are pressed together or one figure stands across a room. This is the one
decision it's better placed to make than a preset field is, which is why I didn't
build the preset field the old note suggested.

### The compiler drops anything else

`keepRealCameraTags()` checks every camera tag against the vocabulary before the
existing one-camera repair runs. An invented one is **dropped**, not demoted to the
caption.

That differs from how setting and outfit are handled, deliberately. A setting phrase
the vocabulary doesn't know may still be a real thing the caption should say. A
framing phrase it doesn't know is a guess dressed as direction — putting it in the
caption just spends caption space on a phrase that means nothing to the model.

```
✓ camera repair — dropped invented camera tag(s) dynamic angle, visceral action
  — not words this model was trained on
```

## One trade worth stating plainly

The camera list is ~520 characters, and it pushed the parser instruction over the
9,500-char budget my own tests enforce. I trimmed it twice (1,113 → 627 → 520) and
it still didn't fit, so I raised the ceiling to 10,100 rather than shave the
explanation into uselessness — the lesson from earlier this session was that
compiler enforcement truncates bad output but only the instruction produces good
output.

That's a goalpost moved, so I've said so in the test comment and in
`NEXT-SESSION.md`: the instruction has grown every session since the 0.29.0 cut
took it to 8,907, and it's due a pruning pass. The two fattest blocks are SCENE
STATEMENT (1,905 chars) and "Keep each image object compact" (940).

## Also: your old note was half stale

`dynamic angle` was never reaching the tag run — the 0.29.0 vocabulary layer was
already demoting it to the caption. So it wasn't poisoning your prompts, just
wasting caption space. The real loss was the camera field being empty of anything
useful, which is what this fixes.

**39 suites · 1186 assertions · all green**, including 15 new ones for the camera list.
