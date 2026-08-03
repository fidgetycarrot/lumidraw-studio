# LumiDraw Studio 0.18.1

A responsive Draw Things workspace inside Lumiverse, with Bridge-powered model,
sampler, and LoRA catalogs plus separate Studio and Story workflows.

## 0.18.1 — explicit Parser engines

Parser mode now has two clearly separated engines.

### Legacy instruction-only — version 0.13 behavior

This is the default after upgrading to 0.18.1 and is intended as the dependable
fallback while the Anima compiler is tuned.

- Uses the same instruction-only parser flow as the known-good 0.13.1 build.
- Sends the selected story passage using the older request shape that previously
  worked reliably in Lumiverse.
- Uses only the Parser instruction shown in the Story tab, plus the old anchor
  output contract needed to place an image near the selected passage.
- Accepts comma-separated image tags directly from the parser.
- Prepends the committed preset's saved quality tags, character tags, and prompt
  prefix, then sends the result directly to Draw Things.
- Does not use structured identity JSON or the Anima deterministic compiler.

### Anima structured — experimental

This retains the newer pipeline for continued testing:

1. The parser extracts compact structured JSON.
2. LumiDraw binds saved character/persona identities and anatomy rules.
3. The deterministic Anima compiler writes the final hybrid prompt.
4. The committed preset's quality tags and negative prompt remain unchanged.

Switching engines does not delete presets, profiles, History, or Story settings.
The Parser instruction Reset button loads the built-in default for the currently
selected engine.

## Parser reliability and diagnostics

- Both engines retain the scan lock, duplicate-trigger protection, live stages,
  elapsed timer, Cancel Parser button, and four-minute timeout.
- Legacy Terminal logs begin with `legacy parser request started` and identify
  the v0.13 transport.
- Anima structured Terminal logs begin with `parser request started` and use the
  newer structured transport.
- Auto Parser and old-message rescanning use whichever Parser engine is selected.
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

## Verify the fallback

1. Confirm the header and Terminal show **v0.18.1**.
2. Open Story and select **Parser**.
3. Select **Legacy instruction-only — version 0.13 behavior**.
4. Confirm the Parser instruction contains the familiar tag-only instruction.
5. Run **Scan latest** and look for `legacy parser request started` in Terminal.
6. Confirm Draw Things receives the parser's direct tag prompt.


## 0.18.1

- Fixes immediate Parser failures on operator-scoped installs by passing the active `userId` in both structured and legacy generation requests.
