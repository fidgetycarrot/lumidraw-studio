# Lumi Studio 1.17.0 — new MOSS prompt layout

MOSS prompts now follow the four-part layout that has worked best in practice (Argon's formula). Anima prompts are unchanged (checked: identical output on six saved scenes).

1. **Tag line:** `masterpiece, best quality, anime style, [rating], [1boy / 2boys …], solo`. The style tag is read from the preset's style sentence (anime, anime key visual, painterly, semi-realistic, comic). In a one-person picture the person's body tags follow (for Vesper: otoko no ko, feminine face, flat chest, petite, slim, narrow waist, wide hips, thick thighs). With two or more people only the counts go here, so body tags don't land on the wrong person.
2. **Style and camera:** the preset's style sentence, then the framing and the light from the scene ("Framed from mid-thigh up, seen from the side, in smoke-brown light").
3. **Each person's look:** the Description for MOSS when there is one, otherwise the tag-built description, with their place in the picture. Face, hair, eyes and figure only.
4. **The moment:** the scene summary, then for each person (by name) clothes, pose and expression, then how they interact, and the setting last.

- Default MOSS negative adds `3d, doll, plastic skin`.
- Prompt only suggests CFG 4 for MOSS (inside the 3.5–5 range that follows the last sentences more closely).
- The experimental layout option (one box per person) is unchanged.

# 1.17.1 — lessons from Argon's live MOSS testing (MOSS prompts only; Anima unchanged)
- **One item per garment:** MOSS read "red coat" beside "crimson silk greatcoat" as two coats. The fullest wording of each garment is kept, a plain catch-all ("black footwear") loses to a named one ("thigh boots"), how it's worn survives ("crimson silk greatcoat on shoulders"), and small parts join their garment ("… with heavy gold bullion epaulets", "black corset with lace cravat", "power armor with pauldrons").
- **"Sleeveless"** is dropped from corsets and vests (it bled onto other people's armor), and bare "breeches" become "fitted breeches" (plain breeches came out baggy).
- **Skin and eyes:** porcelain, alabaster, chalk-white, pallid and pale skin become "fair skin" (no more grey undead look); "around the irises" becomes "inside the irises"; "glowing" is taken off eyes but kept for visors and lenses. This applies to the Description for MOSS box too.
- **Helmet on:** hair, eye and face details are left out of the Description for MOSS for that picture, the way the tag-built description already did.
- **Feminine men without a MOSS box:** "a soft, pretty, feminine face" (which made sharp characters look sweet) is now "delicate feminine bone structure", followed by "His slender body has a feminine hourglass curve with narrow shoulders and a flat male chest."
