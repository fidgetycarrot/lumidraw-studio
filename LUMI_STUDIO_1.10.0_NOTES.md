# Lumi Studio 1.10.0 (staging): MOSS Image prompts (experiment)

A separate prompt builder for the **MOSS Image** model. The Anima prompting is
unchanged: on five real scenes from last week's reports, the Anima prompt and
negative prompt are byte-for-byte the same as 1.9.8.

## How to use it
Library → Presets → Edit your MOSS preset → **Prompt style for story pictures
→ MOSS Image (plain English)**. Then three optional fields:

- **Picture style (one sentence).** Opens every MOSS prompt. Empty uses: *"A
  colorful 2D cartoon illustration in a modern animated-film style, with clean
  outlines, expressive faces and soft cel shading."*
- **Negative prompt for MOSS.** Empty uses MOSS's own recommendation:
  `worst quality, bad anatomy, watermark, jpeg artifact`. Your Story negative
  prompt (score_1 and so on) is written for Anima, so it isn't used here.
- **Give each person their own box (layout, experimental).** Uses MOSS's
  layout format: one box per person, placed by their left/right/background
  position. It might help keep each person's looks on the right body. Turn it
  off if SwarmUI shows the JSON as text or the picture comes out wrong.

The preset card in the Library shows a "MOSS prompts" label. Only the simple
pipeline uses this, and Anima presets behave exactly as before.

## What's shared and what's different
Shared with Anima: the single parser call, character sheets, the per-chat
memory of looks and clothes, the scene card, the setting, the leather-armor
guard and the adult safety negatives.

Different: MOSS reads prompts with a language model (Qwen3.5), so it gets
plain English instead of booru tags:
- The style sentence goes first, then the scene sentence and the framing in
  words ("Framed from mid-thigh up, seen from the side"), then the setting.
- One paragraph per person: "On the right is Bruenor, a muscular, large adult
  man with brown hair, … He wears leather armor and breeches hastily fastened.
  He is standing and holding kite shield. Expression: furrowed brow, looking
  down."
- Anima-only tags are dropped (score_*, masterpiece, 1girl/1boy, rating tags,
  @artist). A few booru words become plain words (tareme → droopy eyes).

The troubleshooting report says which prompt style was used and also keeps the
Anima prompt Lumi Studio would have sent, for side-by-side comparison.

## Settings worth trying in the SwarmUI preset (from MOSS's guide)
Euler, about 50 steps (25 is the SFT default), CFG about 3, shift 5, around 1
megapixel (for example 1024×1024 or 1216×832).

## Known limits
- One hands-on test found MOSS's *anime* look poor. A cartoon/animated-film
  style line is the better bet.
- The layout format is marked experimental by MOSS's own authors.

## 1.10.1: less cartoony default style
The old default style line asked for a "2D cartoon illustration … cel
shading", and that's what came out. The new default is: *"A polished digital painting with semi-realistic proportions, soft painterly shading, rich cinematic lighting and detailed textures."*

Other one-sentence styles to paste into **Picture style**:
- `A still from a modern 3D animated feature film, with stylized proportions, soft global lighting and detailed textures.`
- `A graphic novel illustration with confident ink lines, rich colors and dramatic lighting.`
- `Fantasy concept art in a painterly style, with dramatic lighting, atmospheric depth and rich colors.`

## 1.10.2: no code-like syntax in MOSS prompts
Anima/SD prompt syntax from character sheets, Story settings or the parser is
now cleaned out of MOSS prompts: weights `(tag:1.2)` / `[tag:0.8]`, extra
brackets `(( ))` `{ }`, `<lora:…>` and other `< >` tags, `BREAK`, escaped
parentheses, underscores and `score_9`-style tags. Anima prompts are
unchanged.

If "Give each person their own box" is ticked, the MOSS prompt is JSON on
purpose (MOSS's layout format). Untick it for plain English.
