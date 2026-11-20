# Lumi Studio 1.38.0

Picture fixes after comparing the Nov 13 prompts (when pictures were good) with this week's.

- **Faces always have somewhere to look.** The parser is told every visible face gets a gaze and at least one face cue, even in quiet moments. If it still leaves the gaze out for someone acting with another person, LS adds "looking at another", so they don't stare at the camera. Hidden faces (from behind, close detail shots) are left alone.
- **"From left to right" is back** whenever everyone in the picture has a side. The parser's camera sentence is only used when that line can't be: one person, or people in front of and behind each other. The parser is asked to give positions whenever people are side by side, including a driver and passenger seen from the front.
- **Shorter camera sentence**, in camera words (from the front, from behind, over the shoulder), 20 words at most.
- **No names from outside the picture.** "From David's eyes on the landing" becomes "From the viewer's eyes…" in a first-person shot, and "someone" otherwise.
