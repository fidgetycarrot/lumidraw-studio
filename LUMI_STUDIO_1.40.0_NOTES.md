# Lumi Studio 1.40.0

**Scenery pictures with atmosphere.** From Eric's ice-tree tests: NovelAI can do it, LS was just writing places as a list of what's in the room.

- **A picture, not a list.** For pictures of a place on its own, the parser now builds the setting from: the one main thing, where the light comes from and what glows, the sky or weather, two colours that play against each other, something in the air, and only a few things to place it. All of it comes from what the story says or plainly means. Quiet places get quiet versions. Nothing the story hasn't shown (no creatures, buildings or magic).
- **More room:** a place on its own gets up to 12 setting tags (people pictures stay at 8).
- **Small figure from behind.** When someone arrives before something big or stops to take in a view, the parser can draw that person small, from behind, looking at it.
- **Scenery style.** Pictures with nobody in them keep the style line's look (artist, colouring, light, quality) but leave out its words for faces and bodies, and the artist is turned down to 60%. For Eric's style that gives exactly the "trimmed" test prompt. People pictures use the full style line as before.
