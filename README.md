# LumiDraw Studio 0.18.3

A responsive Draw Things workspace inside Lumiverse, with Bridge-powered model,
sampler, and LoRA catalogs plus separate Studio and Story workflows.

## 0.18.3 — Selective Anima hybrid and anatomy controls

Parser mode still has two clearly separated engines.

### Legacy instruction-only — version 0.13 behavior

This remains the dependable daily-driver path and is unchanged in this build.

- Uses the working instruction-only parser flow.
- Accepts the parser's comma-separated tag prompt directly.
- Prepends the committed preset's quality tags, character tags, and prompt prefix.
- Does not use structured identity JSON or the Anima compiler.
- Existing custom legacy Parser instructions remain preserved.

### Anima hybrid experimental — natural language only where useful

The experimental path remains mostly Danbooru/Gelbooru-style tags. Short natural-
language anchors are now injected only for cross-subject geometry in scenes with
multiple subjects. Solo scenes stay tag-oriented unless explicit visible anatomy
requires an ownership sentence.

The hybrid pipeline is:

1. The parser extracts compact structured JSON.
2. LumiDraw binds saved character/persona identities.
3. Each subject receives a separate named tag block.
4. Up to three short sentences bind multi-character orientation and contact.
5. Setting, camera, lighting, and style remain tags.

## Conditional visible anatomy

The profile editor now labels this field **Conditional visible anatomy**.

- Enter only concrete anatomy that can be hidden by clothing or framing, such as
  `penis`.
- Put identity and presentation tags such as `femboy`, `feminine male`,
  `trans woman`, and `androgynous` under **Permanent appearance tags**.
- Unsupported identity/presentation phrases in the anatomy field are ignored by
  the Anima compiler instead of being converted into malformed exposure text.
- Safe and sensitive scenes never receive an exposed-anatomy sentence, even when
  a profile is set to Always include.
- Relevant-mode anatomy still requires the story to explicitly name and visibly
  depict that saved character's anatomy.

Recognized conditional anatomy is normalized to concrete ownership-safe terms.
This prevents output such as `Sovi's feminine male is visibly exposed.`

## Anima cleanup

- Corrects `androgenous` to `androgynous` in compiled Anima tags.
- Removes the placeholder tag `default outfit` from final prompts.
- Cleans comma boundaries between saved quality tags, prompt prefixes, and the
  compiled prompt without replacing the user's chosen quality tags.
- Keeps the compiler identifier at `anima-hybrid-v3` for prompt/debug comparison.

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

1. Confirm the header and Terminal show **v0.18.3**.
2. Keep **Legacy instruction-only** available as the known-good baseline.
3. In Sovi's Permanent appearance tags, keep `feminine male`, `femboy`, and
   `androgynous`; keep only `penis` in Conditional visible anatomy.
4. Run a safe solo Sovi scene and confirm no anatomy sentence is added.
5. Run a multi-character scene and confirm only the short contact/orientation
   lines use natural language.
6. Compare the final prompt in the Story debug panel before judging the image.
