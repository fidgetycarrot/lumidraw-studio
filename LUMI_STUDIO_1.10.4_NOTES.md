# Lumi Studio 1.10.4: two Anima tips for group pictures

Two small changes to the new pipeline's Anima prompts. They come from a note.com write-up on drawing several characters with Anima: https://note.com/stray_dog0012/n/n6576baad72c1

- **"duplicate, twins" in the negative prompt when two or more people are in the picture.** The Anima team recommends these words to stop characters copying each other or melting together. They're left out when the scene really is about twins.
- **A "From left to right: …" line for three or more people.** It's added only when the parser put at least three people on the left, center or right, and it lists them in that order. Nobody gets moved to a spot the parser didn't give them. The parser is also now told to give each person a different place, and to use left, center and right when three or more stand side by side.

Pictures with one person don't change. Picture details lists each addition when it happens. MOSS prompts are not affected.
