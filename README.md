# LumiDraw Studio 0.42.4

## You were right — you never set an override. The app set one for you.

Two places in `frontend.js` copied the selected connection's model into the
**Model override** field:

```js
// on connection change
if (modelInput && (!modelInput.value || modelInput.value === settings.parserModel))
  modelInput.value = selectedModel || modelInput.value

// and again whenever the connection list reloaded
modelInput.value = currentModel || settings.parserModel || ''
```

Both are gone.

### How it turned into Sonnet running your Kimi tests

1. You picked the Sonnet connection. The field was filled in for you with
   `anthropic/claude-sonnet-5`, and the settings auto-save wrote it to disk as an
   override.
2. You switched to another connection. The re-fill is `selectedModel || modelInput.value`
   — if the new connection reports no model of its own, `selectedModel` is empty and
   the field **keeps the old value**. On the reload path the fallback is even more
   direct: `currentModel || settings.parserModel`.
3. From then on the override beat every connection you chose. `api=generate.raw`
   in your log only happens when an override is set and differs from the
   connection, which is why Sonnet appeared on a Kimi connection.

The field now stays empty unless you type in it. The connection's model shows as
placeholder text — *"leave empty to use moonshotai/kimi-k3"* — so the information
is still in front of you without being a value that gets saved.

### Your existing setting is repaired on load

`clearAutoFilledModelOverride()` runs when the connection list loads. If the stored
override exactly matches some connection's own model, it was written by the picker
rather than typed, so it is cleared from both the field and storage, with a line in
the browser console naming what was dropped. A value that matches no connection is
left alone — that one you typed.

### The log now names the source

```
· model=moonshotai/kimi-k3 · source=connection
· model=anthropic/claude-sonnet-5 · connection model=moonshotai/kimi-k3 · source=model override field
```

## What this means for last night's model comparison

Every run where you changed only the connection dropdown was likely still going to
whichever model got captured first. The DeepSeek, Gemini and Fable conclusions are
not safe — the prompts you judged may have come from one model wearing several
names. Worth re-running a couple of them now that switching connections actually
switches models. The **Re-run parser** button on the regen panel makes that cheap:
same passage, change connection, compare.

Nothing else changed. 36 suites, 966 assertions, all green.
