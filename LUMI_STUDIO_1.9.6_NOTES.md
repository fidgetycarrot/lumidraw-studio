# Lumi Studio 1.9.6 (staging): Scan latest draws the latest reply

**What happened:** in "Direct — only when I press Scan" mode, Scan latest and
Draw now drew an *older* message and placed the picture there, so it seemed
nothing reached the chat. The picture showed Eerodet because it was of the
older temple message.

**Why:** with no message chosen, the backend first looked for the newest reply
still holding a `<lumidraw-parse request="generate">` tag. In automatic mode
the story model is told to end every reply with that tag; in "only when I press
Scan" mode it isn't. So the newest replies had no tag while older ones still
did, and the search kept landing on the last tagged reply. This existed before
1.9; switching to manual mode exposed it.

**Fix:** only automatic scans look for the tag. Scan latest and Draw now now
always use the newest reply. Choose old message is unchanged. Messages are not
edited.

Also: a remembered person (no sheet) is now listed to the parser as "only draw
them if they are physically in the current passage". This guards against the
parser adding someone just because Lumi Studio remembers them.

Checked: with an old tagged reply, a user message and a newer untagged reply,
a manual scan picks the newer reply, an automatic scan with no id behaves as
before, and choosing a message by id still picks that message.
