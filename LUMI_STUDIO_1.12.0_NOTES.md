# Lumi Studio 1.12.0: a new widget, and This chat's pictures

## The widget is one bar

The big button with a small Draw now bubble on its corner is gone. The widget is now one bar with three buttons:

- **Draw now** (highlighted, on the left): draws the latest story message with your current mode and pipeline, same as before. While it draws, its stars twinkle and it can't be pressed again.
- **This chat's pictures** (middle): see below.
- **Open Studio** (right): opens and closes Lumi Studio.

Drag the bar anywhere to move it. Its position is remembered, and a drag never counts as a tap. Each button also works from the keyboard.

**The live preview has its own card.** While SwarmUI draws, a card rises above the bar (or below it, when the bar is near the top of the screen). It shows the picture forming, the progress bar, and "1/2" for batches, then "Done" or the error. It fades a few seconds after the drawing finishes. Tapping it opens Studio. The Draw now note sits just beyond the card. The bar itself never changes size.

## This chat's pictures

The middle button opens a panel over the chat with every picture LS placed in this chat that's still there, newest message first. It only shows the current swipe, and skips pictures you removed or deleted. Each picture shows its message number.

- **Tap a picture** to open it in the normal viewer.
- **Go to message** closes LS and scrolls the chat to that message, with a brief highlight on the picture. Lumiverse only keeps messages near the screen loaded, so for an older message LS scrolls toward it until it appears.
- Tapping anywhere outside the panel, or the ✕, closes it.

## Why not Lumiverse's own gallery

Lumiverse's gallery belongs to the character card, not the chat, so it would mix pictures from every chat with that character. Extensions can also only read it, not add to it.

## 1.12.1: Go to message uses Lumiverse's own Find

On a long chat, 1.12.0 scrolled the chat upward in visible, choppy steps looking for the message, and gave up when Lumiverse hadn't loaded that far back. Lumiverse only keeps part of a long chat loaded, and extensions can't load more or scroll its list properly. Lumiverse's own **Find in chat** (Ctrl/⌘+F) can.

- If the message is already on screen, LS just scrolls to the picture.
- Otherwise LS opens Find, searches a few words that appear in that message (taken from the picture's anchor words, or the start of the message), and lets Lumiverse load the older history and glide there, then closes Find. If the words also match an earlier message, it steps to the next match.
- A note says "Going to message N…". If it can't get there, the note points to Lumiverse's message list in the chat's top bar.

You'll briefly see Lumiverse's Find bar open and close. On a phone, the keyboard may flash up for a moment.

This relies on Lumiverse's Find bar working the way it does today. If a Lumiverse update changes it, Go to message falls back to that note.
