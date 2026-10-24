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
