# LumiDraw Studio 0.84.0 — direct mode, wired

The toggle is real now. **Off by default** — installing this changes nothing
until you turn it on.

## Turning it on

**Settings → Story**, above the image counts:

> ☐ **Direct mode** — let the parser write the prompt

When it's on, the parser gets your character sheets, the wardrobe of record, the
place, your banned words and the fantasy flag, and writes the finished Danbooru
prompt. The compiler doesn't run — not skipped, never reached; the return is
before it, and there's an assertion on that ordering.

Your preset's quality tags still lead the prompt and your negative still trails
it. Those are yours and they're the one part that should be identical in every
image.

## Always include

New field on each character, under the identity fields:

> **Always include (direct mode)** — `futanari`

Whatever you type there is checked after the parser writes and **added back if
missing**. Never rewritten, never removed. It lands at the front of that
character's run so proximity binds it to the right body, and it's skipped
entirely for a character who isn't in that shot — a locked tag stapled onto
somebody else is worse than a missing one.

Empty by default. For Fanny, type `futanari`.

## What driving it uncovered

Wiring it through the real handler threw **`origin is not defined`** on the first
scan. That variable is assembled at the upload site in the compiler path and
doesn't exist as early as direct mode needs it. Reading the code had not caught
it — I'd passed a name that looked right.

That's the third time this project that driving the handler found something
source-reading missed, and it's why the mock exists.

## The part that isn't finished

**I could not complete the end-to-end image assertion.** The run is proven to
reach Draw Things with a built prompt, and every piece — parsing, the lock,
placement, scoping, the context, the rules — is covered at the unit level. But
the mock's image step didn't complete before I ran out of room, so "the lock
fired inside the actually-generated prompt" and "the quality tags led it" are
**not** verified end-to-end.

That's the weakest seam in this release and the first thing I'd finish. I've left
a comment saying so in `direct.mjs` rather than quietly trimming the test into
something that passes for the wrong reason.

## Verification

**58 suites · 2,537 assertions · all green.** 75 in `direct.mjs`.

Mutations caught across both parts: the lock ignoring whether the character is in
the shot, restored tags landing at the end instead of in her run, the prompt
being normalised on the way in.

## What to do

Turn it on, put `futanari` in Fanny's Always include, and run a scene. If it's
worse for something, turn it off — your old pipeline is untouched and the seed is
recorded either way, so you can compare properly.
