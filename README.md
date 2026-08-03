# LumiDraw Studio 0.17.7

A responsive Draw Things workspace inside Lumiverse, with Bridge-powered model,
sampler, and LoRA catalogs plus separate Studio and Story workflows.

## 0.17.7 — Anima hybrid compiler

Parser mode still uses a dedicated LLM to extract a compact structured JSON
scene. The parser chooses subjects, current clothing, pose, support surfaces,
expressions, interactions, setting, camera, lighting, style, and aspect ratio.
It does not write the final Draw Things prompt.

LumiDraw now compiles that JSON specifically for Anima:

1. The preset's saved quality tags remain verbatim at the beginning.
2. The preset's custom prompt prefix remains user-controlled.
3. Anima subject-count tags follow.
4. The central actor-to-target interaction is stated early and explicitly.
5. Every subject receives a named natural-language appearance caption.
6. Current clothing, pose, visible support surface, and expression follow.
7. Setting, camera, lighting, style, and non-action visual modifiers are emitted
   as lowercase Anima tags at the end.

Anima tag normalization uses lowercase and replaces underscores with spaces,
except for `score_*` tags. Proper character names remain capitalized in caption
sentences.

## Identity and anatomy safeguards

- Permanent appearance for saved character/persona profiles remains locked.
- Parser-provided anatomy is stripped from known-character scene fields.
- Conditional saved anatomy requires both `anatomy_visible: true` and an
  explicit subject-owned mention in the source passage.
- Nudity, lowered clothing, arousal, or sexual context alone do not activate
  conditional anatomy.
- When anatomy is included, it is written as an ownership sentence inside the
  correct character caption rather than as a free-floating tag.
- Cross-subject pronouns in two-character pose fragments are resolved back to
  the other saved character's name.

## Retained behavior

- Inline mode remains on the simpler pre-0.17 tag-only path.
- Native Parser trigger interception and render-event fallback.
- Parser scan locks and hard maximum-image enforcement.
- Immediate History updates and manual History refresh.
- Old-message rescanning with chat-message and story-message numbering.
- Studio / Story / Presets / Settings redesign.
- In-app image viewer with zoom, pan, history prompt restoration, and reuse.
- Bridge-powered model, sampler, and LoRA catalogs.
- Draw Things `batch_count` is forced to `1`; only the first returned image is
  accepted for each requested illustration.

## Requirements

1. Draw Things HTTP API enabled, normally at `127.0.0.1:7862`.
2. LumiDraw Bridge 0.2.0 or newer running at `127.0.0.1:7863`.
3. Install the flat ZIP with `spindle.json` at the archive root.

## Verify

The header and Terminal should show **v0.17.7**.

1. Run Parser mode on a two-character interaction.
2. Open **Last Anima parser compile**.
3. Confirm the final prompt begins with your saved quality tags, followed by
   count tags, an early explicit interaction sentence, named character
   captions, and lowercase scene tags at the end.
4. Confirm the preset negative prompt remains unchanged.
5. Confirm conditional anatomy stays absent unless the story explicitly names
   it as belonging to that visible subject.
