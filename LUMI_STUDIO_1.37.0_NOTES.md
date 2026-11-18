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
