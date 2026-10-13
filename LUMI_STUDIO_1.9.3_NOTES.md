# Lumi Studio 1.9.3 (staging): Draw now on the widget

The floating Lumi Studio widget now has a small round **Draw now** button on
its corner.

**It follows your settings because it has no generate code of its own.** It
calls `runStoryScan`, the same function behind Story → *Scan latest*, which goes
to the backend's `scan_story` → `scanStory` → `scanStoryCore`. That routes by
your Mode (Direct or Parser) and by *Use the simple pipeline* (1.9 or 1.8)
exactly as Scan latest does. Earlier generate buttons failed by having their
own path, and this one can't get out of step that way.

- A press always makes a new picture of the latest story message, even if it
  already has one.
- You don't need to open the panel. While it works the button spins and stays
  disabled. The widget's usual preview and progress still show. When it
  finishes, a short note appears next to the widget: the result, or the error
  in plain words.
- In Off or Inline mode it draws nothing and explains why ("Story pictures are
  off. Pick a mode in Story → When to draw.").
- It moves with the widget when you drag it, and stays on screen on a phone.

Checked in headless Chromium against a stand-in backend: one press sends one
`scan_story` with `force: true`; the button is busy then idle again; the result
note shows; the panel stays closed; Off mode sends nothing and explains; the
button follows a drag; and it stays on screen at 390 px. There were no page
errors.

## 1.9.4: twinkle instead of spin
While a picture is being drawn, the Draw now button no longer spins. The big
sparkle gently shrinks and grows back, and the small one fades in and out half a
beat later, in a 1.6-second loop. If your device asks for reduced motion, the
button stays still.
