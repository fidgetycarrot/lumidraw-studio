# Lumi Studio 1.16.0 — Prompt only (for Draw Things+)

For pictures LS can't make itself, such as MOSS on Draw Things+ cloud: LS writes the prompt, you make the picture in the other app, and paste it back.

- **The clipboard button** on the widget (between Draw now and This chat's pictures) opens the Prompt only sheet. Its switch, "Draw now gives me a prompt instead of a picture", turns the mode on. While it's on, the clipboard button and Draw now turn amber.
- **Draw now** then reads the scene and builds the prompt exactly as usual (same parser, sheets, Description for MOSS, wardrobe and memory), but stops before making a picture. The sheet opens with each prompt, its negative prompt (Copy buttons for both), and the size, steps, CFG and shift to set.
- **Adding the picture:** in Draw Things, copy the picture. In LS, click the dashed box on that prompt and press ⌘V. Dropping the file on the box, or Choose file, also works. LS uploads it and places it in the chat at the spot the prompt was written for, like its own pictures: it appears in This chat's pictures, the viewer, Delete and Go to message.
- Prompts wait until a picture is added or you press Remove (the last 12 are kept). Turning the switch off brings Draw now back to normal.
- Pictures over 6 MB are re-saved as JPEG before sending.
