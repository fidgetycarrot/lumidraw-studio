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
