# LumiDraw Studio 0.62.0 — foundation for Looks and Lorebook

Release 1 of 4. **You will see no change in the app.** Everything here is
groundwork the next two releases need, plus one thing that should have existed
already.

Ideas borrowed from [kittyafterdark/LumiSwarm-Studio](https://github.com/kittyafterdark/LumiSwarm-Studio).

## 1. Tests that drive the real message handler

`hostmock.mjs` mocks the Spindle host — storage backed by a real Map, log
capture, image uploads, chats, macros — and runs `onFrontendMessage` for real.

This is the gap that let the swipe bug through. `harness.mjs` loads the backend
with a no-op proxy and pulls out pure functions; it covers the compiler
beautifully and **cannot reach the RPC path at all**. So everything behind the
message handler has only ever been tested by asserting the source *contains* a
pattern.

Source patterns prove the code says the right thing. They can't prove it does
it. `wasProcessed(messageId)` was correct, readable, well-commented code that
returned the wrong answer for a real input — no grep would have caught it, and
none did. A user report did.

`rpc.mjs` now covers, for real: settings round-tripping through save and reload,
the swipe fingerprint, legacy record migration, the pruning window, and the OOC
verdict. 39 assertions, mutation-tested three ways.

**Two things the mock corrected while I wrote it.** The handler doesn't *return*
its reply, it calls `sendToFrontend` — and an unrecognised message type replies
with **nothing at all**, deliberately, because Lumiverse broadcasts to every
extension and answering another extension's message would be the bug. I'd
assumed it returned an error. Both are now asserted.

## 2. A safety scan

`safety.mjs`, adapted from Kitty's `tests/safety-scan.mjs`. It asserts the
backend reaches for no filesystem, subprocess, raw socket, worker, database,
`Bun` system API, `process` control, or dynamic code execution — and that the
frontend doesn't either.

Two deliberate departures from hers:

- **`Buffer.from(…, 'base64')` is blocked in Swarm Studio and required here** —
  Draw Things returns base64 images. So rather than ban it, the scan pins that it
  appears exactly twice and only ever decodes a generated image.
- **Every declared permission is mapped to the host API that needs it**, so a
  permission nobody exercises shows up as a failure rather than living forever in
  a list nobody re-reads.

It also asserts `spindle.json` and `package.json` agree on the version — the
drift that showed you v0.42.3 for six releases, and which Kitty's repo currently
has (1.0.16 vs 1.0.15).

*Written wrong the first time and caught by its own run:* `spindle.chats[...]` is
reached by bracket access, so a `spindle\.chats?\.` pattern reported three
permissions as unused that are used. The scan detects on the object now.

## 3. The dynamic guidance slot

The reason this release exists.

Your static parser rules are measured against a 10,100-character ceiling and sit
at ~10,000. That ceiling isn't arbitrary — it's what stopped the instruction
growing one clause at a time until a small parser model followed none of it. So a
named Look, or an activated location's visual canon, **has nowhere to go**.

`{{dynamic_guidance}}` marks one point in the schema where live guidance is
inserted rather than appended, so the ceiling keeps measuring what it was meant
to: the rules I write, not the scene you happen to be in. A 4,000-character
dynamic block now reaches the parser without touching the static budget.

Same contract Kitty documents: **removing the marker from a custom instruction
opts out of every dynamic block.** Silently appending what someone deliberately
deleted would be worse than losing the guidance.

Both instruction assembly sites route through it — asserted, because if only one
did, a Look would appear on the scan path and vanish on re-parse.

```js
function dynamicGuidanceBlocks(_context = {}) {
  return []          // ← Looks and Lorebook land here, and nowhere else
}
```

Empty on purpose. The next release should be a change to that list and nothing
else; a feature that has to edit the instruction assembly to add one sentence is
a feature that will eventually edit it badly.

## Verification

**48 suites · 1,763 assertions · all green.** 90 new across `rpc.mjs`,
`safety.mjs` and `guidance.mjs`.

Mutation-tested: reverting the swipe fix, coercing `cloudFallback` with `||`,
disabling the prune, deleting the marker, flipping the opt-out default, and
routing only one assembly site through the slot. Every one caught.

## Housekeeping

Your LumiDraw folder was empty when I started — the cleanup took more than the
three files I listed. I restored it from the 0.61.0 release, so this build
descends from that.

## Next

**Release 2 — Named Looks**, on the model you chose: Looks sit *above* the
wardrobe rather than replacing it. Precedence becomes passage > Look > wardrobe >
profile default, so the digest and family-correction work keeps earning its keep
and nothing you have today is discarded.
