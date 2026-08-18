# LumiDraw Studio 0.95.0 — artist tags that fail silently

## What the Style Explorer is actually worth to us

Mostly it's a lookup tool for you, not something to integrate. LumiDraw already
treats artist tags as first-class: it normalises `artist: foo` and `by foo` into
`@foo`, and pulls `@kantoku`-style tags out of your quality prompt into Anima's
dedicated artist slot rather than leaving them wherever they landed. Your
`@cherrymousestreet` was already being routed correctly.

The valuable part is the **index**, not the app — because **a mistyped artist tag
fails silently.** Anima ignores an artist it was never trained on. No error, no
warning: just a blander image, and no way to tell whether the style did nothing
or the name was wrong by one letter. Same class of bug as everything else that's
cost us time this week — a no-op with no symptom.

## Load an index once

**Cast & presets → Anima artist index**, under Banned tags. Paste the list, press
**Load index**. Then **Check my tags** any time:

> `@cherrymousestret is unknown — did you mean @cherrymousestreet?`

It also warns at generation time, in the log, once per distinct problem rather
than once per image — a warning that repeats every generation just teaches you to
ignore it.

The reader is deliberately tolerant: a leading `@`, a trailing work count, a
second comma-separated column, and `#` comments are all handled. You should not
have to clean a 59,000-line file by hand.

**You supply the file, I don't ship it.** A megabyte of names is dead weight for
anyone who never loads one, and a list that belongs to the model is one LumiDraw
can't keep current. Grab `Anima2B_Artist_Index_59k.txt` from the repo you linked.

## The safety property

**With no index loaded, this is completely inert.** Warning about every artist in
your preset because nothing was supplied would be far worse than not checking at
all. There are three assertions on exactly that.

## Also from 0.94

- The `no wait` repair — self-corrections and the count tags they abandon no
  longer reach Draw Things.
- **Playing as** picker, so this chat can be played as Elliot.

## Verification

**59 suites · 2,805 assertions · all green.** New suite: `artist.mjs`, 50
assertions.

Mutations caught: an unloaded index warning about everything (3 failures), a
fixed edit-distance threshold so short names match anything (1), the `@` not
stripped from index entries so nothing ever matches (1), and the early bails
removed — 59,000 names went from under 120ms to **1,755ms**, which is the
assertion that failed.

That last one first reported clean: my perf test used 20,000 short names, which
is fast either way. A mutation that doesn't bite proves nothing, so I re-measured
at the real scale and set the budget from the measurement.
