# LumiDraw Studio 0.17.0

A responsive Draw Things workspace inside Lumiverse, with Bridge-powered model,
sampler, and LoRA catalogs plus separate Studio and Story workflows.

## 0.17.0 — structured subject binding

Story illustration can now use a deterministic subject-binding compiler instead
of asking the parser LLM to write the final natural-language image prompt.

- Parser and Inline modes can return compact structured scene JSON.
- LumiDraw validates the JSON and rejects prose-like fields before any Draw
  Things generation is started.
- Saved character and persona identity profiles provide locked anchors, count
  tags, stable subject phrases, permanent appearance, default outfits, and
  visibility-dependent anatomy.
- Pose, expression, action, interactions, and scene-specific outfits stay in the
  current scene rather than contaminating permanent identity.
- Single-subject scenes compile to compact Danbooru-style tags.
- Multi-subject scenes compile to short, fixed subject clauses with explicit
  left/right/foreground/background ownership.
- Anatomy can be set to Always, Only when explicitly visible/relevant, or Never
  include automatically. The parser only supplies an `anatomy_visible` flag;
  it never rewrites the saved identity.
- The Story screen shows the last parsed scene and the exact final prompt sent
  to Draw Things.
- The legacy tag-only parser remains available by disabling Subject binding.

The parser model does not need to write polished natural language. It only needs
to choose the scene and fill terse schema fields. Values longer than the allowed
short-phrase limits are rejected rather than muddied into an image prompt.

## Retained behavior

- Studio / Story / Presets / Settings redesign.
- Desktop Tune, Create, History, LoRA Library, and Active Stack panes.
- Mobile Create / Tune / LoRAs / Stack / History tabs.
- In-app viewer with safe-area sizing, zoom, pinch, pan, and history reuse.
- Bridge-powered image-model, sampler, and LoRA catalogs.
- Committed chat presets remain isolated from temporary Studio experiments.
- Old-message rescanning and inline/parser story generation.
- Draw Things `batch_count` is forced to `1` and only one image is accepted per
  requested illustration.

## Profile setup

Edit the active preset under Presets. For each main subject, keep these separate:

- **Anchor/name:** repeated ownership anchor, such as `Mara`.
- **Count tag:** model-facing count tag, such as `1girl` or `1boy`.
- **Stable subject phrase:** short identity phrase, such as `adult woman`.
- **Permanent appearance:** stable body, face, hair, eye, and presentation tags.
- **Default outfit:** used only when the current scene does not specify clothing.
- **Anatomy:** visibility-dependent traits, normally genital anatomy.

Stable chest/body traits that should remain present in clothed scenes belong in
Permanent appearance. Scene-specific pose, expression, action, and clothing do
not belong in the profile.

## Requirements

1. Draw Things HTTP API enabled, normally at `127.0.0.1:7862`.
2. LumiDraw Bridge 0.2.0 or newer running at `127.0.0.1:7863`.
3. Install the flat ZIP with `spindle.json` at the archive root.

## Verify

The header must show **v0.17.0**.

1. Open Presets and fill the character anchor, count tag, subject phrase, and
   permanent appearance. Save the preset.
2. Leave **Subject binding compiler** enabled in Story.
3. Test one multi-subject Parser or Inline illustration.
4. Check **Last subject compile** to confirm each identity remained in its own
   clause and the final Draw Things prompt contains no parser prose.
5. Sanity-check Studio, History, image zoom, and both desktop and mobile layouts.
