# LumiDraw Studio 0.44.0

Includes 0.42.4, 0.42.5, 0.43.0 and 0.43.1.

## A preset is now something you can stay inside

I audited every route by which prompt content — positive or negative — could reach
a generation from a preset other than the active one. Three did.

### 1. Scene memory was keyed by chat, not by preset

This is the big one, and it was silently disabling your presets.

Remembered setting **outranks a preset's scene anchor** — that is deliberate, so a
story that moves keeps its new location. But memory was stored under the chat id
alone:

```js
memory[String(chatId)] = { setting, lighting, outfits, at }
```

So the first preset to run in a chat set the location, lighting and wardrobe for
**every other preset used in that chat**. A second preset's Scene anchor was dead
on arrival — it could only ever apply in a chat where nothing had been generated
yet. Testing two presets against the same story compared two presets that were both
running the first one's scene.

Keyed on chat **and** preset now (`chatId::presetName`), through one helper that
every read and write goes through. Each preset keeps its own continuity in the same
chat, and each starts from its own anchor.

Existing memory is keyed the old way. The first preset to ask for it adopts it and
the unscoped entry is deleted, so you keep continuity in whatever preset you are
using now, and no other preset inherits it:

```
[lumidraw] scene memory for this chat is now scoped to the preset "Anima Turbo".
Other presets start from their own scene anchor.
```

### 2. The workspace draft outlived its preset

The Generate tab's draft lives in your browser's local storage and was restored over
the top of whatever preset was active. Draft under preset A, switch to preset B, and
the workspace showed **A's negative prompt under B's name** — indistinguishable from
a bug, which is exactly your complaint.

Drafts are stamped with the preset that wrote them. A draft from a different preset
is not restored; the active preset is hydrated instead. A restored draft says whose
it is: *"Restored your last workspace draft from 'Anima Turbo'."*

### 3. Re-parsing inherited the origin preset

Fixed in 0.43.1, restated here because it's the same principle. Re-run parser and
Replace all images now compile against the active preset. A plain regeneration still
pins the preset the image was made under — that path exists to remake the same
image, and switching models underneath it would be its own bug.

## Checked and deliberately left alone

- **Banned tags, scene anchor, artist tags, quality header** — already read from the
  preset being compiled.
- **Per-compile outfit and negative state** — reset at the top of every compile.
- **Character and persona profiles** — shared across presets by design. They are
  your cast, not a preset's settings.
- **The lightbox regen panel** — shows the image's own stored negative prompt, which
  is what you want when diagnosing that image.

## One thing worth knowing

A stray NUL byte got into the scene-memory delimiter while I was writing it, and my
first test passed only because the same corruption was in the assertion. Caught it
by checking the file's bytes rather than trusting the green tick. Both files are
clean — verified zero NUL bytes — and the delimiter is now an explicit `::`.

New `presets.mjs` suite: 29 assertions. **38 suites · 1062 assertions · all green.**
