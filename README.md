# LumiDraw Studio 0.91.0 — swap a cast member, and the persona hunt

## Your log answered the persona question

```
the chat DTO names no persona. Keys: id, character_id, name, metadata, created_at, updated_at
```

**There is no persona field on the chat.** Only `character_id`. So it isn't a
matter of me guessing the wrong name — it genuinely isn't there, except possibly
inside `metadata`, which is the one opaque field left.

Rather than guess a key inside it, this walks `metadata` for anything
persona-shaped — `personaId`, `persona_id`, `persona: {id|name}`,
`activePersonaId`, or any key matching `/persona/i`. Five shapes, all tested.

And the log now prints the **metadata keys** as well:

> `the chat DTO names no persona. Keys: … · metadata: theme, lastRead`

If it still says no persona, send me that metadata list. If metadata is empty
too, then Lumiverse simply doesn't record a persona per chat, and the honest
answer is that the cast has to supply it — which is what it does today.

## Swap a cast member for one you wrote

> "Fanny Price is in this story, she's just part of the lorebooks instead of the
> character card. I'd want to pull her character tags over even though the
> lumicast fired for her with its own tags."

Every cast row now has a small **— use mine —** picker listing your character
library. Choose your saved Fanny Price and she replaces the story's invented
version in the cast; the story's copy is deleted, since nothing of yours was in
it.

Same safety rule as removal: **a character you wrote is never deleted.** Swapping
one of yours for another only unlinks the first. There's a test.

Works on a bound cast or a preset, whichever the chat is using.

## Also visible in your log

> `character comes from the chat: The Remote`

The world card is in the character slot, as expected. If it starts appearing as a
person in your images, tell me — the fix is small, but I'm not writing it on
speculation.

**58 suites · 2,641 assertions · all green.**
