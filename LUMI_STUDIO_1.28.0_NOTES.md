# Lumi Studio 1.28.0

## NovelAI: people no longer borrow each other's looks

In pictures with several very different people (a big warrior, an elf, two
femboys), one person's build, hair or armour was landing on the person next to
them.

A good four-person picture made on NovelAI's website showed why. Its file
holds the request that made it: one prompt, no character boxes, positions off,
and a `|` between each person. NovelAI reads `|` as "a new person starts
here". LS's `Character (left):` labels were read as ordinary words.

LS now writes NovelAI prompts the same way:

- `|` between people, in one prompt, listed from left to right.
- One plain sentence says who is where: "From left to right: the femboy with
  honey brown hair, the man with dark hair, …".
- A feminine male character is called "femboy" in the scene sentence, not
  "the man". `adult` stays.

Presets with "Give each person their own Character box" turned on are not
changed.

## People without a sheet get a full set of features

A background bard with no sheet and no hair in his tags came out with the
elf's hair. The parser must now give every human-like person without a sheet a
hair colour, hair length, eye colour and build, choosing them itself when the
story does not say, and different from the others in the picture. If it still
leaves one out, LS picks it. Either way it is remembered for the chat, so the
person looks the same next time. This applies to every image app, not only
NovelAI.
