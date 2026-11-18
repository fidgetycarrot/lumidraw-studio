# Lumi Studio 1.37.0

From five reports of posed, standing-apart pictures (Nov 2026).

## Extra pictures are cutaways

With "Fewest pictures per reply" at 2 or more, the parser had to invent a
second moment of the same people, often a weak one ("she nudges her glasses
at a coat peg"). Now the first picture is the main moment and every other
picture is a cutaway, as in a film, a different kind of picture:

- detail: a close-up of a small real thing (hands around a cup, glasses
  pushed up, keys on a table);
- pov: what your character sees, the others looking at you;
- establishing: where they are, from outside or afar (the house at night);
- thing: the object the scene is about;
- mood: rain on the window, a lamp burning low, an empty hallway.

The last three need "Pictures of places and things on their own" on in the
preset. The parser avoids the kinds it used most recently (the last four are
remembered per chat). In a sexual passage cutaways stay on the people: detail
or pov only.

At 0 or 1 nothing changes: one picture of what the cast is doing.

## Simpler shots for NovelAI

The parser's shot sentence asked for staged depth NovelAI cannot draw: people
on different floors, one seen through a doorway, someone far behind. NovelAI
lined everyone up facing the camera instead. The parser is now told to keep
the shot simple: people who are together stay within arm's reach, never on
different levels or behind a doorway, and if people are far apart, frame on
the one who matters. Camera angles are otherwise its own choice.

# 1.37.1

Pictures were going to the top of the reply in a chat using a different
narrator preset. Its replies are about 3,000 characters of story followed by a
13,000-character status block (<sola_hud>, plus <monitor> and <chatterbox>).
1.30.0 only removed blocks with names like <internal_states>, so the parser was
again sent the last 6,000 characters: the status block, and none of the story.
It picked its moments from the block's summary lines and tied the pictures to
them; those lines are not shown in the chat, so the pictures had nowhere to go
and landed at the top. It likely also explains the odd moments the parser
picked in that chat.

Any long block in a custom tag is now treated as machinery and removed before
the parser sees the reply, unless its name says it holds the story (<story>,
<narrative>, <response> and so on). Place, time, date and weather inside it are
still kept as a short note. If removing blocks would leave almost no text, the
reply is used as it was.

Checked on three saved replies from two presets: the parser now gets the
story text (about 3,000 characters each) where it got only status blocks.

# 1.37.2

Backgrounds made no sense inside a house. A report showed why: the house was
remembered as one place, "Oak Lane house", with the look "two-story suburban
house, oak plank floor, wooden banister staircase, warm cream walls, wall pegs
by the stairs", and that look was added to every picture anywhere in the
house. "Two-story suburban house" made NovelAI draw the outside of a house
behind the people in the upstairs hallway, and every room got a staircase.

- The parser now treats each room as its own place ("Oak Lane kitchen", "Oak
  Lane upstairs hall") and describes the room, never the building's outside.
- Indoors, Lumi Studio drops words for a whole building ("two-story house",
  "brick building", "facade") from the setting, including from places saved
  before this update, and adds "indoors". Outdoors (a porch, the street) they
  are kept.
