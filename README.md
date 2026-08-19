# LumiDraw Studio 0.99.0 — the picker worked; two other places never asked it

## What was happening

`preset.personaTags` is the flat legacy field from when characters lived on
presets. In your install that's Jason.

**Two places appended it to the parser instruction directly** — never going
through `getStoryProfiles`, so the Playing-as choice could not possibly reach
them:

- the legacy parser instruction
- the inline-mode protocol injected into the chat

The picker was working fine. These two never asked it anything, and one of them
sits on the manual/inline path — which is why you hit it doing a manual parse.

Both now resolve properly: **your choice for this chat → the bound cast → the
preset.**

## One rule worth stating

**An explicit choice with an empty sheet means "no persona tags"** — not "fall
back to the one I just replaced". Falling back there would reintroduce this exact
bug for anyone whose persona is a name and a vibe rather than a tag list. There's
a test.

## And a diagnostic, because this hid twice

The persona binding is per **chat**. A choice saved under one chat id and a
generation run under another looks *identical* to the picker being ignored — and
manual parsing reaches the resolver from a different entry point than the auto
scan. So the log now says:

> `persona: no choice recorded for chat 4a3f59d3 — but 1 chat(s) do have one:
> 8b21ce90. If that list should include this chat, the ids did not match and the
> picker needs setting again here.`

If you see that line, the fix is one click. If you see `persona: you chose
"Elliot" for chat 4a3f59d3` and Jason still shows up, it's a third injection site
and I want to know.

## Verification

**61 suites · 2,888 assertions · all green.**

Mutations caught: the legacy field winning again (3 failures — the reported bug),
an empty chosen sheet falling back to the old persona (2), the chat-id mismatch
going silent (2).

Two of my own earlier assertions failed and I updated them rather than reverting:
one pinned the exact log wording, the other the code shape around the choice. The
property each was testing is unchanged, and the reason is written into the test.
