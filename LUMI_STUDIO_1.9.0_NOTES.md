# Lumi Studio 1.9.0 (staging): Simple pipeline

## What was wrong

The parser was mostly getting things right. The steps after it were throwing
those right answers away.

In the temple scene (troubleshooting reports from 2026-10-13), the parser
returned Eerodet as "the tall woman on the left", a goddess in an open moss-green
robe, Bruenor in leather armor with unfastened pants, and a full temple setting.
Anima received `1boy, 1person`, Bruenor's body, and nothing at all about
Eerodet's body. So it drew Bruenor twice.

- **People without a sheet had no way into the prompt.** The parser was told
  "Lumi Studio supplies identity, don't repeat appearance", but for an unsaved
  character nothing supplied it. Jev rated Eerodet "girl" at 62%, the cutoff was
  85%, so she became `1person` with no body tags.
- **Clothes came from story memory, which rejected most things.** The scene
  card's "Road-worn leather armor, breeches undone" was marked not supported
  because the prose didn't repeat it. A disputed garment was then "no longer
  treated as worn", so clothes came and went between images. Unsaved characters
  couldn't store clothes at all.
- **The setting was dropped for not citing a sentence number.**

## What changed

A new **Simple pipeline**, on by default in Direct mode
(Story → *Simple pipeline · 1.9*). Turn it off and 1.8 runs exactly as before.

1. **One parser call.** A new, shorter instruction keeps the Anima prompting
   rules (expression cues, framing words, act list, rating rules, and position
   tags), and asks for one object per person: outfit, pose, expression, and,
   **for people without a sheet, count + subject + appearance + anatomy**.
2. **The scene card goes to the parser** as the story model's own note of who's
   wearing what and where they are.
3. **A plain compiler** builds the same layout as 1.8: header + counts,
   `Scene:`, `Setting:`, one paragraph per person (`Name, an adult man, on the
   right: body. Clothing: … Pose and expression: …`), then the interaction
   lines. Saved sheets still decide saved characters' body, count and anatomy.
   Nothing is removed for lack of a quote.
4. **Per-chat memory** (`simple_cast.json`): after each picture, every
   person's outfit is remembered, and an unsaved person's look is **locked the
   first time it's known**. Both are handed back to the parser next time, so
   faces and clothes stay the same until the story changes them.
   *Show what this chat remembers* and *Forget this chat* are in the same card.
5. With the simple pipeline on, **no Jev calls, story-memory calls,
   between-image wardrobe calls or final review calls** are made.
6. Troubleshooting reports now say where each person's body, count and clothes
   came from (sheet, story, remembered, scene card).

Clothing fallback order: what the parser says now, then remembered, then the
scene card, then the sheet's default outfit. Setting: parser, then remembered,
then the scene card, then the preset scene anchor.

## Checked

- `node --check` on both files.
- Replayed report A's real passage and saved persona through the new compiler,
  with an example reply in the new format: `1girl, 1boy`, Eerodet gets a body
  and futanari anatomy, Bruenor keeps "unfastened breeches", the setting is
  present, and the second image reuses Eerodet's remembered look even when the
  parser described her differently.
- Replayed the *old* parser reply as well (the 1.8 format still works as a
  fallback): Eerodet comes out `1girl` from "the tall woman on the left", but
  without body tags, since that format never carried them.
- Full scan and re-parse run end to end against a stubbed Lumiverse: images are
  placed at their anchors, memory is saved and fed back on the next run, and the
  re-parse retry note gets through.
- Panel loaded in headless Chromium: the toggle shows and is on, and the memory
  view renders.

**Not yet run inside a live Lumiverse, or with your parser model.** The real
test is whether your parser model fills the new `appearance` field for unsaved
people. The troubleshooting report will show this ("body: story (parser)" vs
"nothing known").
