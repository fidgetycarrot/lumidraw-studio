# Lumi Studio 1.18.5 — five parser rules borrowed from the Anima scene-parser prompts

Parser rules only; the prompt layout for each model is unchanged. They improve what the parser reports, so Anima, MOSS and prose models all benefit.

1. **The place is where they are now.** A place they talk about, plan to visit or remember is not the setting until the story shows them arrive.
2. **Dividers.** When a counter, desk, table, bar or doorway is between people, the scene summary says so ("on opposite sides of the desk"), or that they sit side by side at it. MOSS reads the summary directly.
3. **No invented contact.** Only contact the passage states or clearly shows; no touching, hand-holding or leaning in just because the mood is warm.
4. **Only what a camera could see.** No smoke, haze or steam made up for a smell, sound or feeling.
5. **Light with a source and side** when the story gives them ("lamplight from the left", "window light behind her"). MOSS puts it in the style-and-camera sentence.

# 1.18.6 — Paste picture button (works with pictures copied on an iPhone)
- Each waiting prompt in the Prompt only sheet has a **Paste picture** button. It reads the clipboard directly and waits for a picture copied on another Apple device (Universal Clipboard), which ⌘V often misses because the picture hasn't arrived yet. The browser may ask once to allow clipboard access.
- Works in Safari on the iPhone too, so the whole round trip (Draw Things+ → copy → Lumiverse → Paste picture) can happen on the phone.
- HEIC or TIFF pictures are re-saved as PNG before sending.
- If ⌘V brings no picture, the card now says to use Paste picture instead of doing nothing.
