# LumiDraw Studio 0.80.0 — answering "will it just autopopulate?"

Short version: **images, yes, automatically. The panel needed two fixes, and one
thing still needs you once.**

## Images were always fine

The scan takes its chat id from the message event, and an event is never wrong
about which chat its message is in. So the right cast is used for the right chat
with no action from you — that part needed nothing.

## Gap 1: the panel could show the wrong chat

The panel followed the last chat it saw an **event** from. Switch chats and open
it without generating anything, and that id points at the previous chat — and
because 0.72.0 made the frontend always send something, a stale id started
beating the fallback that used to work.

The host's idea of which chat is on screen now wins; the panel's remembered id is
the backstop for hosts that can't answer.

## Gap 2: two of your chats are probably sharing one cast

Auto-binding matches a chat to the cast that came from its preset. Both your
chats use the same preset, so **both bound to the same cast.**

Their wardrobes are genuinely separate — the key is chat + cast — but the
membership *list* is shared. So a character one story introduces joins the
other's list too. That's your original complaint returning through a side door.

It can't be guessed away: two chats with genuinely the same two people is a real
thing, and silently making copies would be its own surprise. So the panel says
it, in amber:

> Fanny · Jason · **shared with 1 other chat: a character introduced in either
> one joins both. Press Copy to give this story its own.**

## What you need to do once

1. In your second chat, press **Copy**. That chat now has its own cast; the first
   keeps the original.
2. Prune each one with ×. Mara, Dev and Ochoa where they don't belong.

After that: switch chats, the right cast loads, the right wardrobe loads, and a
character the story invents joins only the story that invented it. No further
maintenance.

## A test-infrastructure bug worth naming

`resolveActiveChatId` reads `spindle.chat`**s** — plural. The host mock only ever
defined `spindle.chat` — singular. So it silently returned `null` in **every test
that has ever run**, and "the host says which chat is on screen" was never
exercised once. The mock has `chats` now, opt-in so it doesn't rewrite what
existing tests mean.

Then I wrote the new test overriding `spindle.chat.getActive` and it failed for
the same reason. Same one-letter confusion, twice in ten minutes.

## Verification

**57 suites · 2,439 assertions · all green.** 146 in `cast2.mjs`.

Mutation-tested two ways, both caught: the stale panel id winning over the host
again (5 failures), shared casts not being reported (1).
