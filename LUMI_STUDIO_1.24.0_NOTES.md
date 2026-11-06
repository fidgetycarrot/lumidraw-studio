# Lumi Studio 1.24.0 — hairstyles from the story

- **The parser reads how hair is worn** (ponytail, braid, bun, twintails, hair down, hair over shoulder…) from the story, the same way it reads clothes. Colour and length still come from the sheet.
- **Remembered like an outfit.** Stories mention a ponytail once and then never again, so the last hairstyle seen is kept for later pictures until the story changes it ("she let her hair down", "tied it back up"). The parser sees it as CURRENT HAIR.
- **The sheet is the starting point.** A hairstyle in a sheet's appearance tags (Lauren's `ponytail`, Tara's `single braid, hair over shoulder`) is where that person starts until the story says otherwise. With none, the image model decides until the story says something.
- People without a sheet work the same way; their remembered body no longer carries a hairstyle, so it can change.
- Hair accessories (ribbons, scrunchies, clips) are still clothes.
- Works for Anima, MOSS tags and NovelAI. A MOSS sheet's written description is used word for word, so a hairstyle written there stays.
