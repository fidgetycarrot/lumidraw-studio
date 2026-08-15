# LumiDraw Studio 0.86.0 — the watchdog was killing direct mode

> Stage "compiling" exceeded its 60s budget — a host call likely hung.

Nothing hung. **Direct mode was working and the timer killed it.**

## What happened

The scan reports a stage as it goes, and each stage has a budget. `compiling` gets
60 seconds, because in the compiler path it's string work — the code moves the
stage to `generating` before it asks Draw Things for anything.

My direct-mode runner never did that. It ran the whole thing — identity lock,
banned words, the actual image — while the stage still said `compiling`. So an
80-second generation on your laptop got killed by a timer meant for string
manipulation.

It moves to `generating` before each image now, reports which one of how many,
and ends on `inserting` like the compiler path does.

## The pattern, again

Same shape as the toggle that didn't save: I built the new path and didn't carry
over something the old one did along the way. Twice now — the settings list, the
stage transitions. Both invisible in tests that check each piece separately,
because each piece was fine.

Worth me remembering that "new path beside the old one" means auditing what the
old one *does*, not just what it produces.

## Good news buried in the error

That message means direct mode was running. The toggle saved, the parser was
asked for a prompt, and it got as far as Draw Things. This is the last thing
between you and actually seeing it work.

**58 suites · 2,548 assertions · all green.**
