# LumiDraw Studio 1.3.0 — your 1.1.2, with my 1.2.0 merged in

**Your files are the base.** Not mine. Everything in your 1.1.2 is intact, and I
re-applied my work on top of it rather than the other way round.

## What I verified, not assumed

A diff of your `backend.js` against the merged one shows exactly **two** lines of
yours missing — both are calls I deliberately replaced with versions that do
strictly more (`applyIdentityLock` now runs after name-stripping;
`repairDirectPrompt` now feeds the BREAK-splitter). Your `frontend.js` differs by
**one hunk**, described below.

Your whole `applyUiResetV11()` — all 496 lines — is untouched.

## Your work, which is better than what it replaced

- **`LUMIDRAW_PRESET_SEMANTICS_V1_1`.** Presets are generation recipes; story
  prompting moved to settings; people live in casts. That's the separation you
  proposed days ago, done properly, with a one-time migration that copies and
  leaves the preset fields intact.
- **Direct promoted to a first-class mode**, with `parser + directMode` installs
  auto-promoted. `directMode` is now *derived* from the mode, so the two can no
  longer disagree with each other.
- **The wardrobe precedence ladder** — passage change > current wardrobe > earlier
  mentions > default, and *silence means unchanged*. This is better than my "THE
  PASSAGE ALWAYS WINS". Mine couldn't express "the passage says nothing", which
  made silence look like a reason to reset to defaults.
- **Per-character anatomy containment** — futanari/penis/bulge must stay inside
  that character's block. That directly addresses traits landing on the wrong
  person.
- **Resolve contradictions before output** — which is the `couch` vs `lying on
  bed` problem solved at the source.
- **Stable futanari in Permanent appearance is promoted to the identity lock.**
  I'd deleted a noun-inference fallback because it found nothing for Fanny; you
  fixed the actual case instead of generalising. Narrow, from a named list.
- Parser temperature control.

## One regression I found in the merge

`openStoryPicker` accepts `parser` **and** `direct`, but the gate on the button
that opens it still said `parser` only — left behind when Direct stopped being a
checkbox. So in Direct mode "illustrate an old message" was greyed out while the
thing behind it worked perfectly. That's the single frontend hunk I changed.

## My 1.2.0, re-applied

The fused-block splitter and name-stripper from this morning's positioning bug.
They're now enforcement backstops for rules **you** wrote — your `NEVER` line
already forbids names as tags and self-corrections left in place.

## The test suite

**62 suites · 2,971 assertions · all green** against your architecture.

29 assertions failed on the merge and I went through them one at a time. Every
one was my test pinning wording or a control you deliberately changed — none was
a lost behaviour. Each is rewritten to assert the property against your source,
with a comment saying what changed and why. Three were brittle in ways worth
fixing regardless:

- one pinned the *exact end* of a selector list, so any addition broke it — it
  checks membership now
- one counted raw occurrences of an attribute instead of distinct sections
- one asserted "init never writes", which your declared one-time migration
  legitimately violates — it now asserts the write is declared, once, and
  **idempotent**, and there's a new test proving a second init changes nothing

The settings-tab test came out better than either version: it now ties the
switcher's accepted list to the tabs that survive your UI reset, so a dead tab or
an unreachable section fails.

## Going forward

This is on me to prevent, not you. Your changes now live in the source I build
from, so they carry forward automatically. If you edit your install directly
again, send me the file the same way and I'll rebase rather than overwrite — and
I'll say plainly in every release which files are being replaced wholesale.
