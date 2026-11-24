# Lumi Studio 1.43.0

**The room as one sentence (NovelAI).** Eric's test on the Reverie gym-bedroom: adding one sentence about the room after the scene sentence brought out the tub, bed, matting, power rack, lamps and beams that the tag list alone had lost.

- The parser now writes a "room" sentence for pictures with people: the place as the camera sees it in this shot, near to far, with the size the story gives ("the long cedar room opens out", "across the room", "against the far wall"). Only what would be in view, not everything the place holds. From the story's own description, in line with the saved place, no people, nothing the story hasn't shown.
- LS puts it on its own line right after the scene sentence, before "From left to right". Names become "the man" / "the woman" like the other sentences.
- Left out for close-ups where the place barely shows, and for pictures with nobody in them (their summary already describes the place).
- The place's tags stay as they are, so the room still looks the same from picture to picture.
- The framing rule now points to the wide first shot for a newly described place, instead of overriding it.

## 1.43.1
Eric: "not everything needs to be visible… the bed and squat rack are on different ends of the room."
- **Clear rules for what the room sentence can show.** The parser works out where the people stand and which way the camera faces; only the part of the place behind them in that direction shows. What's on the other side, beside the camera or behind it, doesn't, however much the story says about it. At most two objects, near then far.
- **A place's saved look is now only what's true from any spot in it:** walls, floor, ceiling, colours, size, light fittings. Single objects in one part of the room (a bed, a bar, a tub, a rack) are no longer saved as its look; they go in the room sentence when they're in view.
- **Places already saved with their furniture:** when there's a room sentence, only the first three saved looks (what the place is made of) are used, so the bed, tub and rack aren't put in every picture.

## 1.43.2
- **Light from things out of view.** A strong light the story puts outside the frame (a glowing orb, a fire, a neon sign, sun through a window behind the camera) goes in the room sentence by its light alone: its colour, the side it comes from, what it falls on. The thing itself isn't drawn. The same light also goes in the setting as a short tag ("blue light from the left").
