# LumiDraw Studio 0.61.0 — swipes are illustrated again

Includes 0.60.0 (the face-to-face contradiction).

## Your instinct was the diagnosis

*"The only difference I can think of is this was a swiped message."* That was it.

A swipe replaces a message's **content** but keeps its **id**. LumiDraw recorded
what it had illustrated as a bare list of message ids:

```js
async function wasProcessed(messageId) {
  const list = await spindle.storage.getJson(PROCESSED_FILE, { fallback: [] })
  return list.includes(messageId)          // ← the id, and nothing else
}
```

The original message had images, so its id was in that list. The swipe arrived
with the same id, matched, and was skipped as *"already illustrated."* A brand
new passage, never illustrated, silently discarded.

## Why the log looked like a crash

This is the half that made it undiagnosable, and it's the part I'd fix even if
swipes had never existed.

That check returns **before any logging**. So the log showed the interceptor
running, the protocol injected, the trigger queued, two triggers deduplicated —
and then nothing at all. A successful skip and a crashed scan produced byte-for-
byte identical output.

Both skip paths now log. If this ever happens again you'll see:

```
[lumidraw] auto scan skipped · this message was already illustrated · message=277579c3-…
```

which is a sentence you can act on, rather than silence you have to guess at.

## The fix

A record is now `messageId:fingerprint` — which message *and which text*. Same
id with different content is a different record, so a swipe reads as unillustrated
and gets its images.

Details worth knowing:

- **Upgrading is quiet.** Records written before this version are bare ids. Those
  are still honoured, so nothing gets re-illustrated on install — and the first
  time one is read, the text it's read alongside is adopted as its content, so
  the *next* swipe of that message is caught.
- **Only the authoritative caller writes fingerprints.** The early check compares
  against the event's copy of the content, which can differ from the stored
  message. A wrong "not illustrated" there costs one message fetch and is caught
  by the real check inside the scan. A wrong "illustrated" is the expensive
  direction, and that path can't produce one.
- **A superseded record is pruned**, not accumulated, so a heavily-swiped message
  can't crowd out the 50-entry window.
- Forcing a rescan by hand still bypasses the whole check, unchanged.

## Verification

**45 suites · 1663 assertions · all green**, 29 new in `swipe.mjs`.

Mutation-tested three ways — reverting the read to id-only, dropping content from
the writes, and removing the log line. Each break was caught, including the
silence, which is now itself a tested property.

## Note for the next time this happens

The general shape here is worth remembering: *the log ended where the code
returned early.* When a scan seems to vanish, the last line printed tells you
which branch it took, and a branch that prints nothing is a branch that can hide
a bug indefinitely. Every early return on the auto path now says so out loud.
