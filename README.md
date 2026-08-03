# LumiDraw Studio 0.18.2

A responsive Draw Things workspace inside Lumiverse, with Bridge-powered model,
sampler, and LoRA catalogs plus separate Studio and Story workflows.

## 0.18.2 — Anima hybrid experimental compiler

Parser mode still has two clearly separated engines.

### Legacy instruction-only — version 0.13 behavior

This remains the dependable daily-driver path.

- Uses the working instruction-only parser flow.
- Sends the selected story passage using the older generation request shape.
- Accepts the parser's comma-separated tag prompt directly.
- Prepends the committed preset's quality tags, character tags, and prompt prefix.
- Does not use structured identity JSON or the Anima compiler.
- Existing custom legacy Parser instructions are preserved during upgrade.

### Anima hybrid experimental — structured anchors + legacy-style tags

The experimental path is now deliberately much closer to the successful legacy
prompt style:

1. The parser extracts compact structured JSON.
2. LumiDraw binds saved character/persona identities and anatomy rules.
3. The compiler keeps the final prompt mostly Danbooru/Gelbooru-style tags.
4. It injects at most three short natural-language relationship anchors for
   body arrangement, contact ownership, and multi-character scene adherence.
5. The committed preset's quality tags and negative prompt remain unchanged.

The hybrid compiler no longer writes full natural-language character paragraphs.
Each subject gets a separate named tag block, while natural language is reserved
for the areas where tag-only prompts are most prone to character bleed.

## Hybrid ordering

The experimental prompt is compiled as:

1. Saved quality tags and prompt prefix.
2. Safety and subject-count tags.
3. Up to three short spatial/contact sentences.
4. One separate tag block per character.
5. A subject-owned anatomy sentence only when explicitly visible and permitted.
6. Setting, camera, lighting, and style tags.

The structured contract now asks the parser to establish a visible base pose
before motion or intensity. For multi-subject scenes, the first relation should
state body arrangement or orientation, and later relations should state clear
contact points. When lower-body contact matters, the parser is instructed to use
framing wide enough to show it rather than defaulting to a close-up.

## Parser reliability and diagnostics

- Both engines retain the scan lock, duplicate-trigger protection, live stages,
  elapsed timer, Cancel Parser button, and four-minute timeout.
- Legacy Terminal logs begin with `legacy parser request started`.
- Anima hybrid Terminal logs begin with `parser request started`.
- Auto Parser and old-message rescanning use the selected Parser engine.
- Maximum images is enforced before Draw Things generation.

## Retained behavior

- Inline mode remains on the simpler pre-0.17 tag-only path.
- Immediate History updates and manual History refresh.
- Old-message rescanning with chat-message and story-message numbering.
- Studio / Story / Presets / Settings redesign.
- In-app image viewer with zoom, pan, prompt restoration, and reuse.
- Bridge-powered model, sampler, and LoRA catalogs.
- Draw Things `batch_count` is forced to `1`; only the first returned image is
  accepted for each requested illustration.

## Requirements

1. Draw Things HTTP API enabled, normally at `127.0.0.1:7862`.
2. LumiDraw Bridge 0.2.0 or newer running at `127.0.0.1:7863`.
3. Install the flat ZIP with `spindle.json` at the archive root.

## Suggested testing

1. Confirm the header and Terminal show **v0.18.2**.
2. Keep **Legacy instruction-only** available as the known-good baseline.
3. Select **Anima hybrid experimental** for structured tests.
4. Run the same story message through each engine.
5. Compare the final prompts in the Story debug panel before comparing images.
