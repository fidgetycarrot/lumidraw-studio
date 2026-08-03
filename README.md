# LumiDraw Studio 0.17.5

A responsive Draw Things workspace inside Lumiverse, with Bridge-powered model,
sampler, and LoRA catalogs plus separate Studio and Story workflows.

## 0.17.5 — parser safeguards, fast Inline restored

This update separates the two story paths again:

- **Inline mode** uses the simpler pre-0.17 comma-separated tag protocol. It
  does not run a parser model, structured compiler, complexity score, or model
  router. This keeps Inline fast and close to its previously reliable behavior.
- **Parser mode** retains structured subject binding and adds interaction-first
  compilation plus a hard anatomy firewall.

Parser safeguards:

- Shared physical interactions are placed before the independent character
  descriptions so actor and target ownership is established early.
- Multi-subject prompts request one unified image and guard against split
  screens, panels, collages, and duplicate characters.
- Saved character/persona names are recognized even when the parser returns a
  first name or incorrectly labels one as an `other` subject.
- Parser-provided anatomy terms are removed from known-character scene fields.
- Conditional profile anatomy is included only when the parser marks it visible
  **and** the source story explicitly names that saved anatomy.
- Sexual context, nudity, lowered clothes, arousal, or post-sex context alone do
  not activate conditional anatomy.
- `Always include` still uses the saved profile; `Never include automatically`
  still suppresses it.
- Relation instructions require active actor-to-target wording.

There is no automatic complexity scoring, model switching, or additional LLM
pass. The selected mode and parser model are used exactly as configured.

## Retained behavior

- Studio / Story / Presets / Settings redesign.
- Desktop Tune, Create, History, LoRA Library, and Active Stack panes.
- Mobile Create / Tune / LoRAs / Stack / History tabs.
- In-app viewer with safe-area sizing, zoom, pinch, pan, and history reuse.
- Bridge-powered image-model, sampler, and LoRA catalogs.
- Committed chat presets remain isolated from temporary Studio experiments.
- Old-message rescanning in Parser mode.
- Draw Things `batch_count` is forced to `1` and only one image is accepted per
  requested illustration.

## Requirements

1. Draw Things HTTP API enabled, normally at `127.0.0.1:7862`.
2. LumiDraw Bridge 0.2.0 or newer running at `127.0.0.1:7863`.
3. Install the flat ZIP with `spindle.json` at the archive root.

## Verify

The header must show **v0.17.5**.

1. Test Inline once and confirm its `<dt-image>` body is ordinary comma-separated
   tags rather than JSON.
2. Test Parser with two interacting subjects.
3. In **Last parser subject compile**, confirm `Shared interaction` appears before
   the two identity blocks.
4. Confirm conditional anatomy stays absent unless it is explicitly named in the
   story passage.
5. Sanity-check Studio, History, image zoom, and both desktop and mobile layouts.
