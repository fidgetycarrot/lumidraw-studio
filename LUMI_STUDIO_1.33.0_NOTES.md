# Lumi Studio 1.33.0

## Remaking a picture starts with a new seed

In the viewer's "Fix this image" panel, "Reuse the original seed" now starts
unticked. Tick it when you want the same composition with an edited prompt.

## More choices for automatic pictures

Automatic pictures can now come every 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15 or
20 story replies (it was every reply or every 5).

## More pictures of places, mood and things that matter

Pictures without people used to be only for arriving somewhere new or seeing
something for the first time, at most one per reply. The parser may now also
draw:

- a place shown in a new light or weather, even one already drawn;
- what sets the mood (a storm, candles burning low, the aftermath of a fight);
- a thing the story turns on or reveals (a letter, a key, a weapon, an orb in
  an open chest), close up.

It prefers such a sight about one time in three when it weighs about the same
as the people moment.

Sexual passages are the exception: the picture is of the people and the act.
The parser is told so, and if a reply has any adult picture or act, a picture
of a place or thing alone from that reply is dropped.

The switch is unchanged: "Pictures of places and things on their own" under
Setting in the preset.
