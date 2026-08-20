# LumiDraw Studio 1.1.0 — no browser required

## First, a correction to what I told you

**You never needed a browser at home.** The extension's frontend runs in whatever
browser you're actually using — your work one. Home only ever needed the server.
I said "auto-illustration only runs while the Lumiverse page is open" and left
you to work out *which* page. That was sloppy.

## But the real thing you're asking for was broken

LumiDraw's backend registers its **own** `GENERATION_ENDED` trigger. That's the
whole point of a server-side fallback: illustrate with no browser anywhere.

**It had never fired. Not once, in any install.**

```js
const uid = payload.userId || eventMessage.userId || lastUserId
if (!uid || !messageId || !chatId) return
```

`lastUserId` was assigned in exactly one place — inside `onFrontendMessage`. So
the backend couldn't name the user until a **frontend connected**, which is
precisely the dependency the fallback exists to remove. And it reset to `null` on
every extension restart, so even a working install lost it.

Then it `return`ed with no log at all. A trigger that gives up without a word
can't be diagnosed, and this one had been giving up silently since it was
written.

## The fix

The user id is now **remembered on disk**. One browser connection, ever — then
the backend illustrates on its own, across restarts, with nothing open. You'll
see:

> `remembered user id restored — automatic illustration can run without a browser
> open`

And when it genuinely can't, it says so instead of vanishing:

> `backend GENERATION_ENDED ignored — missing a user id (no browser has ever
> connected to this install)`

## Why nobody caught this

The host mock stubbed lifecycle events to a no-op, so **no test in this suite had
ever fired one.** The backend's automatic trigger — arguably the most important
path in the extension — had zero coverage. The mock can fire events now, and
`headless.mjs` drives the real handler with no frontend involved at all.

That's the second time this project a whole capability turned out to be untested
because the mock quietly answered nothing (the first was `spindle.chats`).

## Verification

**62 suites · 2,921 assertions · all green.** New suite: `headless.mjs`.

Mutations caught: back to memory-only (2 failures — the original bug), the id
never written to disk (3), the silent return restored (2), a failed generation
illustrating anyway (1).
