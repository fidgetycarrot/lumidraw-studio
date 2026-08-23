# LumiDraw Studio 1.3.4 — native image mount reliability fix

## Why this build exists

1.3.3 moved new LumiDraw story images out of message HTML and into Lumiverse's native `ctx.dom.inject()` mount system, following the same architecture used by SimTracker. The first implementation had a race: if the backend announced an image placement before the target message bubble was mounted, the initial attach failed and the later `CHARACTER_MESSAGE_RENDERED` retry incorrectly required a `chatId` that the render event does not always carry.

## 1.3.4 changes

- **Fix first-attach race.** A known image placement now stays pending until its message bubble is mounted.
- **Message ID is enough for render retry.** `CHARACTER_MESSAGE_RENDERED` retries a pending image by `messageId` even when the event has no `chatId`, matching SimTracker's render-intent pattern.
- **Short event-scoped retry burst.** The initial placement notification tries immediately, on the next two animation frames, and once after 180 ms. After that it waits for Lumiverse's own render event. This is not a polling loop.
- **Safety refreshes.** Completed manual/automatic scans refresh native image placements in case the placement notification raced with frontend lifecycle events.
- **Native mount resizing only.** The chat-image width control now owns the width of LumiDraw's injected image container directly. Pre-1.3.3 markdown/HTML images are deliberately left entirely to Lumiverse; LumiDraw no longer probes or resizes legacy inline-image wrappers.
- **Virtualization lifecycle cleanup.** Pending mounts and timers are cleared on chat switches, swipes, deletes, and extension cleanup.
- **`generation_parameters` permission added.** LumiDraw sends parser request parameters such as temperature and token limits, so the manifest now explicitly requests the current Spindle permission for generation-parameter access.

## What to test first

1. Confirm the LumiDraw header says **v1.3.4**.
2. If Lumiverse asks for the new `generation_parameters` permission, grant it.
3. Send a new assistant message that triggers a LumiDraw image.
4. Confirm the new image appears underneath the correct message without rewriting the message content.
5. Move the LumiDraw image-width slider while the image is visible; the native mount should resize immediately.
6. Scroll far enough that the message virtualizes away, then scroll back. The injected image should return with the message.

## Intentional compatibility choice

Old images created before the native-mount architecture are not resized by LumiDraw in 1.3.4. They remain normal Lumiverse message-content images. This avoids reintroducing wrapper probing, global DOM scans, or CSS workarounds that can fight the current virtualized message list.
