# LumiDraw Studio 0.46.1

Install this instead of 0.46.0 — it includes it, and 0.46.0 alone would not have
helped you.

## What 0.46.0 missed

It checked the message being illustrated. But user messages are never illustrated
in the first place, so the `[ooc]:` marker was on a message LumiDraw already ignored.
The message that *does* get illustrated — the assistant's reply — carries no marker
at all. It just answers.

## How it works now

The **preceding user message** decides whether to look. The **reply's own shape**
decides the verdict, because you use OOC to direct the story as well as to talk
about it.

```
user:      [ooc]: can we back up a scene?
assistant: Sure — where would you like to pick up from?
           → skipped: addressed to you rather than describing a scene

user:      [ooc]: continue from the shower
assistant: Sovi stepped under the water, steam curling around her shoulders...
           → illustrated: the reply names Sovi
```

Both decisions are logged:

```
[lumidraw] the message before this one was out of character · skipping — the reply
is addressed to you rather than describing a scene
[lumidraw] the message before this one was out of character · illustrating anyway —
the reply names Sovi
```

### What counts as narrative

In priority order:

1. **Addressed to you** → aside. *"Would you like…", "Shall I…", "I can…", "Got it",
   "Understood", "my mistake", "no problem".* This is checked first deliberately —
   *"Understood, I'll keep Sovi out of the next scene"* names a character but is
   still a reply to you, so naming the cast must not veto it.
2. **Contains dialogue** → scene.
3. **Names your cast** → scene. Pulled from the active preset's profiles, matching
   both the anchor and the prompt name.
4. **Talks to you about the writing** — meta nouns plus "you" → aside.
5. **Short with no past-tense sentence** → aside. *"That works for me." "Yes."*
6. Otherwise → scene.

Only the nearest preceding user message is considered, and the search stops at any
intervening assistant message, so this cannot reach back into an unrelated exchange.

### Scope

The classifier runs **only** when the preceding user message is out of character.
An ordinary story message never touches it, so it can't cost you an image in normal
play.

`ooc.mjs` is up to 67 assertions, including the reply pairs above.
**39 suites · 1154 assertions · all green.**
