# LumiDraw Studio 0.87.0 — it never put the pictures in the story

Your log had it exactly:

```
story scan stage · inserting · Adding generated images to the story message.
direct mode produced 1 image(s); the compiler did not run
story scan stage · done
```

`inserting` and then `done`, with **nothing between them**. The image was
generated, uploaded and written to history, and never placed in the message.

Generating the picture isn't the job. Putting it in the story is. I built the
whole mode and left out the thing it exists for — then announced the stage that
claims I did it.

## Fixed

Direct mode now writes the message back, anchored to the sentence the parser
chose so the picture lands at the moment rather than the top. Unanchored images
go to the top rather than being dropped, the parser trigger is stripped, and the
message is marked processed so a re-scan doesn't duplicate it — all the things
the compiler path does after generating.

## The pattern, third time

- The settings list — the toggle didn't save.
- The stage budget — the watchdog killed it.
- The insertion — the images went nowhere.

Every one is the same mistake: I built a path beside the old one and carried over
what it *produces* without auditing what it *does along the way*. Each piece
tested fine on its own. Nothing tested the sequence.

The honest read is that my end-to-end assertion — the one I couldn't finish in
0.84 and flagged as the weakest seam — is exactly what would have caught all
three, and I shipped three releases without it. That's the thing to fix next, and
this time I'd rather do it before adding anything else.

## Also worth seeing in your log

The prompt direct mode actually produced:

> 2people, dirt road, grassy rise, western marches, dusk approaching, wide shot,
> full body **BREAK** 1girl, futanari, … oversized hoodie, no pants, striped
> thighhighs, black panties, bulge, holding sketchbook, drawing with pencil
> **BREAK** 1boy, extremely muscular, … black t-shirt, sweatpants, sneakers,
> standing behind her, holding warhammer planted in dirt

Two characters, one contiguous run each, no prose, no cross-talk, correct
clothing on both, `bulge` in the right place. That's the format working.

**58 suites · 2,557 assertions · all green.**
