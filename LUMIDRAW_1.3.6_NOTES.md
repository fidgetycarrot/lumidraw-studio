# LumiDraw Studio 1.3.6 — Direct prompt/continuity rethink

Built on 1.3.5. The native SimTracker-style image mounting and anchor placement are unchanged.

## Direct-mode changes

- The interaction gets a mandatory early scene-sentence slot, before character identity runs.
- Character sheets are supplied as paste-exact identity anchors instead of loose notes.
- Direct JSON now carries rating plus optional changed-setting and changed-outfit sidecars.
- Direct wardrobe is now a closed loop: explicit passage changes can be remembered for the next image; silence still means unchanged.
- Wardrobe sidecars are grounding-checked before persistence, so an invented garment can render once without becoming permanent story state.
- Stable identity locks are matched from the identity anchor rather than from clothing.
- Explicit anatomy can mechanically add `uncensored` plus censorship negatives, and penis-family-only characters can add female-genital negatives. These touch fixed header/negative slots, not the parser-authored body.
- Rating is reconciled against stale preset safety tags before generation.
- Direct images are ordered by anchor position before generation.
- Remembered outfits now keep up to 12 tags instead of 6 so a complete outfit sidecar is not truncated.

## Small integration correction

The supplied `directAnchorFor()` included the count tag even though the prompt grammar separately requires a count tag before the identity anchor. 1.3.6 intentionally keeps the count tag separate to avoid `1girl, 1girl, ...` duplication while retaining the paste-exact identity design.
