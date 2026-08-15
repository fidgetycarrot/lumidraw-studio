# LumiDraw Studio 0.85.0 — the toggle didn't save

You turned it on. It didn't stick. That's why yesterday's prompt was still
compiler output.

## What happened

The settings panel auto-saves on change, but only for controls named in an
explicit selector list. I added the checkbox, wired it into the save payload,
made it restore on load — and never added it to the list that *triggers* a save.

So it rendered correctly, read correctly, restored correctly, and was never asked
to write. **Direct mode shipped permanently off with no way to turn it on.**

Every source assertion I wrote passed, because each was individually true. Nothing
checked that the four halves were connected to each other.

One line. `.ld-direct-mode` is in the list now, and there are four assertions that
hold the halves together rather than checking them one at a time.

## About the test I didn't write

I tried three times to write a general sweep — *every checkbox in the save
payload must also be in the trigger list* — and got it wrong three different ways:
matched the wrong list of two similar ones, asserted a rule that isn't actually
true (several controls save through their own handlers), and then a listener
regex that doesn't match how they're really bound.

Three wrong versions is the signal that I don't understand the invariant well
enough to assert it. A fourth attempt would just be tuned until it went green,
which is exactly how a decorative test gets written. So it's not there, and the
reason is in the file.

The four specific assertions are real and would catch this regression.

## Now try it

Install, tick **Direct mode**, and check it's still ticked after a reload — that's
the thing that was broken. Then run the Corin/Price scene.

If the clothing still swaps in direct mode, sides are worth investigating. If it
doesn't, that was the compiler and there's nothing to fix.

**58 suites · 2,543 assertions · all green.**
