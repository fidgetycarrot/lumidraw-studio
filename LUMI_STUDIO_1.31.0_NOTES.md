# Lumi Studio 1.31.0

Four prompts from a real chat showed the same thing: fixed rules making bad
pictures. Each change below replaces a fixed rule with a judgment the parser
makes for that moment.

## Faces match the moment

Since 1.27 the parser was told to always give eyes, mouth, brows, an emotion
word and a gaze. That made every face act at full strength: a man listening to
a phone got "wide-eyed, parted lips, raised eyebrows, surprised".

Now the parser decides how strong the moment is. Quiet moments (talking,
listening, driving, teasing) get one or two light cues and a gaze. Heightened
moments (a fight, real shock, grief, sex, a birth) get the whole face. Emotion
words are used only when the story shows that feeling plainly, and someone
speaking gets "parted lips", not "open mouth".

## Eye contact

When two people each look at the other, Lumi Studio adds "eye contact" to
both. "Looking at another" on each did not make their eyes meet. (NovelAI
prompts.)

## The parser pictures the shot first

For NovelAI the parser now writes one plain sentence saying where the camera
is and how people sit in the frame, and it has to be a picture a camera could
take in that place. That sentence goes into the prompt.

It replaces Lumi Studio's own "From left to right" line, and the rule from
1.29.3 that two people always get left and right. Inside a truck cab seen from
the side, those two together asked for a row of people that cannot exist, and
NovelAI put one of them in the back seat. Left and right are now given only
when that is how the camera sees them. If the parser gives no shot sentence,
the old line is still used.

## Tidier setting

A remembered place plus the moment's tags came to fourteen, several saying the
same thing twice. Near-duplicates are dropped and the list is capped at ten:
the moment's own tags (light, weather, where in the place) are kept, and the
place's saved look fills the rest. New places are saved with 4-6 tags, not
6-10.

## Checked

Built against a fake parser: a truck scene with and without a shot sentence,
two people looking at each other, and the earlier place, clothing and anatomy
tests. No real parser model or picture was run from here.
