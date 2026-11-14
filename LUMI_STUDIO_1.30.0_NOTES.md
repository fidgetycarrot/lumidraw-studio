# Lumi Studio 1.30.0

## The parser now reads the reply, not the story's hidden bookkeeping

Found while trimming the parser's instructions, from a report.

Some narrator presets end every reply with a long hidden block of their own
bookkeeping (`<internal_states>`: map, timeline, memories, agendas), wrap
status panels in `GFX` comments, and write a blank braille character for every
space. In the report, a reply had about 4,200 characters of story followed by
about 12,300 of bookkeeping.

Lumi Studio sends the parser the last 6,000 characters of a reply. So the
parser was sent bookkeeping only, and not one word of the reply itself. It
drew from the block's summary lines and tied the picture to them, which is why
pictures kept landing at the end of the reply. The earlier messages it was
given for context were the same.

Now, before the parser sees a reply:

- the hidden block and the status panels are removed;
- the braille blanks become ordinary spaces;
- the block's place, time, date and weather are kept as one short note, so the
  parser still knows it is mid-afternoon in the therapy office.

On the reply from the report the parser now gets the story text (3,400
characters) where it used to get none. Pictures can be tied to the right
paragraph again; the frontend matches the braille blanks when it looks for it.

Pictures already made are not touched.

## Shorter instructions

The parser's main instructions are about a tenth shorter. Rules that said the
same thing twice were merged (people without a sheet, the three lists of face
words, the setting), and one that Lumi Studio enforces itself was dropped. No
rule was removed.

## Checked

Lumi Studio's own cleaning was run on the reply saved in the report, before
and after. The place, no-people and clothing tests from 1.29 still pass. No
real parser model was run from here.

# 1.30.1

"futanari, penis" was being added to a woman whose sheet has neither. Lumi
Studio adds missing anatomy from each person's part in a sexual act, and when
the parser wrote the act the wrong way round (the woman as the one penetrating
because she is on top, or the man as the one giving paizuri), the woman got
the penis.

- When the part that needs a penis went to a woman without one and the other
  person can have one, the two are swapped, with a note in the report.
- An act alone never adds a penis to a woman. Her sheet does, or the parser
  for someone without a sheet.

# 1.30.2

Unusual anatomy (futanari, a woman with a penis, a man with a pussy) now comes
from a character sheet and nowhere else. The parser is told never to write it,
and if it does for someone without a sheet, or it was remembered from an
earlier picture, Lumi Studio leaves it out and says so in the report. A
character who should have it needs it on their sheet.

# 1.30.3

1.30.2 was too strict: a futanari met in passing would have needed a sheet.
Now:

- A character WITH a sheet: only what the sheet says.
- Someone WITHOUT a sheet: the parser may give them unusual anatomy when the
  story says so outright, and it is remembered for the chat.
- An act alone still never adds it (1.30.1), and the parser is told not to
  work it out from who is doing what or who is on top.

# 1.30.4

A woman remembered as wearing no bra was drawn with her blouse open in an
ordinary, fully dressed picture. The three tags Lumi Studio adds for that
("no bra, covered nipples, breasts apart") did it: the same prompt and seed
with "covered nipples" alone drew the blouse closed.

Pictures that are not adult now get "covered nipples" only. Adult pictures
keep all three. "No bra" is still remembered either way.
