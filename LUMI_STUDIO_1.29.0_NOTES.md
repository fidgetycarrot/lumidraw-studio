# Lumi Studio 1.29.0

## Places stay the same

The first picture set somewhere now fixes how that place looks: what it is
built of, its colours, and the two or three things that mark it out. Lumi
Studio saves that under the place's name for the chat. Every later picture
there, with or without people, starts from the same words, so the tavern you
walk back into is the same tavern.

- The parser names the place and lists its lasting look separately from the
  moment (light, weather, time of day, the corner people are sitting in).
- A place already drawn keeps its saved look even if the parser describes it
  differently later. "The Stag" is matched to "the Gilded Stag".
- Story images → "What Lumi Studio remembers in this chat" lists each place.
  "Forget this chat" clears them with everything else.
- Up to 24 places per chat; the oldest drop off.

What it keeps is materials, colours and landmarks. It does not keep the exact
layout: the fireplace may be on a different wall.

## Pictures of places and things on their own

When the story arrives somewhere new, or shows something for the first time (a
building, a ship, a landscape, a creature), the picture can be of that alone,
with none of the story's people in it. At most one per reply, and never when
the reply is mainly something happening between people.

On for every preset. To turn it off, untick "Pictures of places and things on
their own" under Setting in the preset.

## Pictures spread through the reply

Pictures were landing at the end of the reply most of the time, because the
parser kept choosing the closing beat. It is now told to take the earlier
moment when two are about equally clear.

## Checked

Run against a fake parser and a fake NovelAI: a place picture with no people,
a later picture with people in the same place under a shorter name (saved look
used, the parser's different description ignored), a creature on its own, and
the switch turned off. Anima and MOSS prompts were built for a place picture
too. No real picture has been drawn with this yet.
