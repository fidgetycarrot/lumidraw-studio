# LumiDraw Studio 0.98.0 — the choppy scrolling is ours

Not a clash. It's LumiDraw, and it's one function.

## What was happening

`markFixableChatImages` runs on a **4 second timer** over every `<img>` on the
page — that's the thing that marks which chat images can be re-generated. For
each image it called two lookups, and **each of those rebuilt the entire
flattened history array from scratch**, then ran a regex over every entry's full
prompt string looking for a substring match.

So the real cost, four times a minute, on the main thread:

> images on page × images in history × a regex over a whole prompt

It grows with your chat length *and* your History tab, which is exactly why it's
bad **now** — you're at 51 saved images. A periodic main-thread stall during
scrolling is what choppy scrolling *is*, and "it gets stuck on images" is the
same stall landing while images are in view.

## The fix

Same answers, computed once per history change instead of once per image:

- Two **Maps** for URL and recorded-alt lookups — O(1).
- The substring fallback, which can't be a Map, now only exists for entries with
  no recorded alt, and is evaluated **at most once per `<img>` element**, cached
  in a WeakMap.
- The index rebuilds when `history` changes, detected **by reference** rather
  than by hooking the nine places history gets assigned — a missed hook would be
  a silently stale index.

A tick over an unchanged chat is now a WeakMap lookup per image.

Measured at your scale — 51 history images, 60 chat images, 40 ticks:

> **41ms → 2ms**

The timer stays at 4 seconds. It was never the cadence that was wrong; it was
the work per tick.

## One honest note on the benchmark

The shipped function needs a DOM, which the test harness doesn't have. So the
timing above runs a faithful **model** of both strategies over realistic data,
and the structural assertions — index built once, WeakMap guard, Maps used, the
per-image rebuild gone — run against the real file. I'd rather say that than
imply I benchmarked something I didn't.

## What I did NOT find

The images themselves are inserted as plain markdown `![alt](url)` with alt
capped at 100 characters. Nothing bloated, and how they're laid out while loading
is Lumiverse's renderer, not something LumiDraw can reach. If it's still choppy
after this, that part is worth looking at next — but this was measurably wrong on
its own.

## Verification

**61 suites · 2,876 assertions · all green.** New suite: `perf.mjs`.

Mutations caught: the WeakMap guard removed so every image is re-searched every
tick, the index never rebuilding so new images are never marked, and a revert to
the full per-image search.
