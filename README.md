# LumiDraw Studio 0.89.0 — the leads come from the chat

Jason was pinned, Fanny was pinned, and neither could be removed. The
chat-membership rule only ever applied to `castLibraryIds` — the supporting
cast. The character and persona slots were returned unconditionally:

```js
character: await resolveProfile(character, ...),
persona:   await resolveProfile(persona, ...),
cast,      // ← only this was filtered
```

And casts had no editor, so Copy handed you a duplicate you couldn't change.

**The cast was the wrong place to answer this.** Lumiverse already knows which
character card and which persona a chat is using, and that answer is always
current. So the chat supplies the two leads; the cast supplies the supporting
characters and everyone's outfits.

Start a new chat with a different persona and it just works.

## It only ever replaces, never merges

A chat that names nobody keeps the cast's leads. An unreadable chat keeps them.
A persona id that resolves to nothing keeps them, and says which id failed.
Nothing gets worse when the host can't answer — there's a mutation asserting
that an unreadable chat doesn't wipe the character.

## Every field name is a guess, and says so

I can't see your chat DTO, so each id is a **list** of candidates —
`characterId`, `character_id`, `characterIds[]`, `characters[].id`, and the
same four shapes for persona. All eight are tested.

If none match, the log prints the DTO's **actual keys**:

> `the chat DTO names no persona. Keys: id, title, createdAt, …`

Send me that line and I'll add the real field. It fails loudly rather than
silently doing nothing, which is how the last three bugs hid.

## The toggle

**Take the character and persona from the chat** — on by default, in the Cast
panel. Off returns to the cast's own leads.

And it's in the selector list that triggers a save. That's the thing I missed
with direct mode, and there's an assertion naming it so it can't happen a third
time.

## Verification

**58 suites · 2,605 assertions · all green.** 45 new.

Mutations: the persona never taken from the chat (8 failures), an unreadable
chat wiping the character (7).
