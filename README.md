# LumiDraw Studio 0.58.0 — the scan queue

Includes 0.57.0 (Draw Things Cloud Compute) and everything before it.

## I went looking for a background queue and found a bug instead

You said generation times were your biggest complaint. Looking at how a slow
generation actually behaves, slowness was not only costing you time — **it was
costing you pictures.**

Here is the code a story message ran when another scan already held the lane:

```js
while (activeStoryScan) {
  if (Date.now() - slotStarted > PARSER_TIMEOUT_MS + 90000) {
    throw new Error('Automatic scan waited too long for the current story scan to finish.')
  }
  await wait(750)
}
```

**Two failures in four lines.**

### 1. The stopwatch

Five and a half minutes of waiting, then the message throws and is **never
illustrated**. At roughly 47 seconds an image plus a parser call, a scan takes
two to three minutes. Two messages arriving behind one slow scan meant the second
one quietly died. You would have seen this as "sometimes it just doesn't
illustrate a message" — with no error in the chat, because the failure happened
in a background job.

The faster your machine, the rarer this is. Which is exactly why buying cloud
compute would have *hidden* this bug rather than fixed it.

### 2. No order — and this one may matter more

Every waiting message ran its own 750ms timer. Whichever happened to test the
condition first took the lane. **There was no queue, just a scramble.**

Scene memory is written by each scan in sequence — the wardrobe of record, the
setting, the remembered outfits. Illustrating message 12 before message 11 teaches
it stale state, and 0.56's grounded writes then *defend* what they learned.

I can't prove this caused any specific outfit drift you saw. But it is a
mechanism by which the record could go wrong while every piece of the clothing
pipeline behaved exactly as designed — and we spent 0.53 through 0.56 hunting
drift on the assumption that ordering was a given.

## What replaced it

A real queue. First in, first out, **no stopwatch**. A message waits as long as
the line ahead of it takes, and the per-scan watchdog remains the thing that
bounds a scan that has genuinely hung.

- **Ordering is guaranteed**, so scene memory learns in story order.
- **A long wait is never a dropped message.** Waiting costs time, not pictures.
- **The panel shows your place** — "Waiting to be illustrated — second in line" —
  so a slow queue reads as a queue moving rather than the extension having died.
- **Depth is capped at 12.** Past that the *oldest* waiter is dropped, named in
  the log, and told how to get it back — if the queue is genuinely backed up, the
  recent messages are the ones still on your screen.
- **A message illustrated while it waited is not illustrated twice.** The check
  re-runs after the wait, since you may have pressed Scan yourself.

### One race worth naming

The queue hands the lane over before the scan sets `activeStoryScan`. A manual
Scan pressed inside that window could take the lane out from under the queued
message, which would then be turned away as "busy" — reintroducing the exact
silent loss the queue exists to stop. There is now a separate lane token held
across that gap, and a manual scan in that window is told *"Press Scan again in a
moment"* rather than being allowed to steal it.

## Verification

**44 suites · 1612 assertions · all green** — 41 new in `queue.mjs`.

Mutation-tested: I broke FIFO into LIFO, made the cap drop the newest instead of
the oldest, and removed the lane token. Each break was caught.

**A test failure I want to flag, because it nearly fooled me.** Under the
lane-token mutation, the assertion "the lane is never held by two scans at once"
*passed* — while a direct probe of the same mutation showed three scans running
concurrently. The queue is module-level state, an earlier block had left the lane
held, and that leaked state made a later block's assertion pass by accident. Every
block now asserts the queue is clean before it starts, which turns contamination
into its own visible failure. The mutation fails properly now.

That is the second time this project has produced a test that passed for the
wrong reason. The first was the NUL byte in the scene-memory delimiter. Both were
caught by trying to break the thing rather than by watching it pass.

## Nothing here depends on the cloud build

This is all local. Whether or not the Swift build finishes, whether or not Anima
turns out to be usable on cloud, your messages now queue instead of racing.
