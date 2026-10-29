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

# 1.17.2 — more of Argon's MOSS findings (MOSS prompts only)
- **No blank eyes:** when nothing says an eye colour (sheet tags or the Description for MOSS box), a woman or man gets "dark eyes". MOSS drew blank white eyes otherwise. Not added under a worn helmet. Skin tone is not guessed: a wrong guess would change who the character is.
- **Cyborgs:** "a cyborg woman" became "a woman … with subtle cybernetic implants" (leading with "cyborg" drew a bare robot body over the clothes). Full-body machines (android, robot, mecha, full-body) keep it. Loose "cables" / "cables running from her body" become "thin cybernetic cables plugged into the back of the neck".
- **Hats and scalp implants:** with a hat, hood, cap or cowl worn, "set into the scalp" in the MOSS box becomes "at the temples and neck", so MOSS keeps the hat.

# 1.17.3 — painterly middle-ground MOSS styles & anti-both-poles negative
- **Painterly middle-ground presets in the Picture style dropdown:** added **Heroic Book-Cover Illustration (oil & acrylic)** (new default), **Classic Oil Painting**, **Gritty Dark Fantasy Oil**, **Painterly Concept Art (gouache & ink-wash)**, **Vintage Pulp Illustration**, **Muted Gouache / Matte Illustration**, **Storybook Watercolor**, and **90s Retro Cel Anime**.
- **No forced `anime style` or `masterpiece, best quality` on painterly styles:** `mossTagLine` now uses the resolved style (`style` rather than raw `chosen`), only includes `masterpiece, best quality, anime style` when an anime style is actually chosen, and uses physical painting medium tags (`painterly illustration, oil painting`, `gouache illustration`, etc.) for painterly styles.
- **Anti-cartoon & anti-plastic negative prompt:** upgraded the default MOSS negative to block plastic/CGI/photo drift (`photorealistic photograph, DSLR, glossy CGI, 3D render, Unreal Engine, plastic skin, smooth airbrushing, digital art smoothing, doll, mannequin`) and automatically appends anti-cartoon terms (`anime, cartoon, cel shading, chibi, flat vector art, thick comic outlines`) whenever a non-anime style is used.

# 1.17.4 — smooth non-brushstroke MOSS styles & plain-English dropdown
- **Smooth illustration styles first (no brushstrokes, no cartoon cel-shading, no real photos):** put **Smooth Semi-Realistic (Slice of Life & Everyday)** (new default), **Mature Manhwa / Visual Novel (Clean & Stylized)**, and **Clean Concept Art (Darker / Sci-Fi & Fantasy)** at the top of the Picture style dropdown, with plain-English names across the list.
- **Automatic anti-brushstroke protection for smooth styles:** when using a smooth non-anime style, automatically adds `thick oil paint, impasto, visible brushstrokes, canvas texture` alongside the anti-cartoon and anti-photo negative terms.

# 1.17.5 — restore cohesive per-character MOSS blocks & fix 3D/photo drift
# 1.17.6 — what you see in the preset is what gets sent
- **No hidden style or negative rewriting:** removed background rewriting of saved `mossStyle` sentences and removed automatic style-based additions/deletions on `mossNegative`. Whatever is shown in the preset's **Style sentence** and **Negative prompt for MOSS** fields is sent as written (or the visible placeholder default if the field is left empty).
- **Cohesive one-paragraph-per-character layout (from 1.15.1 & Studio test):** keeps each character's appearance, outfit, helmet, and pose together in a single paragraph rather than splitting looks from outfits/poses, preventing Grimnir's wolf pelt from bleeding onto Vesper and preserving Grimnir's towering height (`standing ... towering`).
- **Specific armor & sub-part retention:** raised `simpleKeepSpecific`'s word cap from 4 to 6 so `"storm-grey ceramite power armor"` upgrades to the full sheet description, and carries over matching garment sub-parts (`oversized bronze-runed rounded shoulder pauldrons`, `heavy gold bullion epaulets`) from the sheet's default outfit.

# 1.18.0 — UI & UX overhaul ("what you see is what gets sent")
- **Story tab overhaul:**
  - **Top card (`Story pictures`):** combines `Scan latest` / `Choose old message…` with `Image preset` and `Drawing mode` right at the top, and hides `How often` unless an automatic mode is selected. Rare options (`Most pictures per reply`, `Fewest pictures`, `Most people`, `Use the simple pipeline`) are tucked into a collapsed **More drawing options** drawer.
  - **Live `Style & negative prompt` card on the Story tab:** automatically adapts to the active preset's engine (MOSS vs. Anima). When a MOSS preset is active, all Anima tag fields are hidden and you see & edit the active preset's **Picture style**, **Style sentence sent to MOSS**, and **Negative prompt sent to MOSS** right on the Story tab (with automatic saving back to the preset and pre-filled defaults so the boxes are never blank).
  - **Compact `This chat` card:** keeps `Cast`, `Playing as`, and `Add a saved character` front and center, and tucks chat memory and species/lead options into a **Chat memory & cast options** drawer.
- **Tabbed Character & Persona Sheet Editor:** replaces the 15-field vertical wall with a compact top basics grid (`Library name`, `Story name`, `Count tag`, `Short role phrase`) and 3 clean tabs: **MOSS & Outfit** (default), **Anima Tags**, and **Forms, Props & LumiCast**. Library cards also show a `MOSS` badge and preview the plain-English MOSS description when present.
- **Streamlined Settings:** combines `Help & reports` and `Old pipeline (1.8)` into a single **Help & legacy** tab with the old 1.8 settings tucked inside a collapsed drawer.
