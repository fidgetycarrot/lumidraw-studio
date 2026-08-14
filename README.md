# LumiDraw Studio 0.66.0 — retries that differ, anatomy that holds, and a way to show me

Three things, and the third exists because of the point you made.

## 1. Re-parse was sending the identical request

Not the model being stubborn. `reparseSourceMessage` rebuilt byte-for-byte the
same instruction, with the same passage, to the same model. **The button said
"try again"; the request said "do it again."**

A parser has no memory between calls, so the only way to ask for something
different is to show it what it already produced and say that was rejected. It
now does exactly that — the previous prompt comes out of the history entry and
goes back as a rejected attempt.

It escalates, too:

- **First retry** — read the same moment again, produce a *different* scene:
  reconsider the body arrangement, who is where, the contact points, the framing.
- **Second and beyond** — a small variation isn't enough; choose a **different
  moment** of the passage entirely.

Every retry also points the parser at the **relations**, since an unusual
arrangement is the most likely thing to have been read wrong.

Attempts are counted per image, so pressing the button again pushes harder rather
than rerolling the same dice. The status line tells you which attempt you're on.

## 2. The futanari with a vagina

There was a real gap. `anatomyDefence` guards a penis **bleeding onto a second,
ordinary female subject**, and it deliberately exempts a character whose own
identity is futanari — negating "futanari" on a futanari is negating who she is.
That's correct, and it left the solo case completely uncovered.

**Nothing in your prompt has ever said "not a vagina."** Anima's prior for a
feminine body in an explicit scene supplies one unless told otherwise, and an
unusual position gives it more room to fall back on that prior — which is exactly
when you see it.

So there's now a second, separate defence that negates the female-genital family
when **every** subject whose anatomy is being drawn has penis-family anatomy.
Scope is deliberately tight:

- A scene with a futanari **and** an ordinary woman negates nothing — her body is
  not the error.
- A character *defined* with female anatomy is protected even in a frame where
  her anatomy isn't drawn, because a negative applies to the whole image.
- Safe and sensitive scenes never get genital negatives at all.

The two defences stay separate and neither absorbed the other.

## 3. A diagnostic you can paste without pasting your story

You said it plainly: I make a fix, you send the app's actual output, and my
diagnosis changes. That happened three times tonight — the OOC gate, the swipe,
the cloud model. Every one of those, my reading of the code was wrong and the
output corrected it.

The answer to "this scene is explicit" is **not** for me to trust the code
reading more. The code reading is what kept being wrong.

**Settings → Advanced → Diagnostics → "Copy report for Claude (no story text)"**

It emits structure only:

- safety level, aspect, camera tags
- per subject: ref, count tag, **anatomy family** (`penis` / `female` / `none`),
  the profile's family, anatomy mode, whether anatomy was visible, active look,
  appearance state, and **counts** of outfit and appearance tags
- relations as shape only — has actor, has target, has action, how many details
- the negative prompt, which is where an anatomy failure shows up: either the
  guard didn't fire, or it fired and the model ignored it
- the compile trace, with detail kept for structural rules and **omitted** for
  anything that could carry prose

No passage, no scene statement, no caption, no prompt, no relation text. Tested:
the suite builds a report from a scene containing an explicit relation and
asserts none of the outfit, appearance, or relation strings appear in the output.

That turns "we fly blind" into "we fly on instruments." If the next image is
wrong, send me that and I can tell you whether the guard fired.

## Verification

**52 suites · 1,992 assertions · all green.** 52 new in `retry.mjs`.

Mutation-tested: solo futanari unprotected, retry stops escalating, and the
ordinary-woman exemption removed.

**That last one initially passed, which meant the guard was dead code** — the
`allPenis` check already covered it. Rather than leave a check that couldn't
fail, I made it load-bearing: it now reads the *saved profile* rather than the
rendered descriptor, which is the genuinely different question. Same class of
thing as the `if (!name) return null` I deleted in 0.64.0.
