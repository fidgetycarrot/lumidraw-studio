# Lumi Studio 1.25.0 — presets per chat

- **Picking a preset in a chat remembers it for that chat.** Opening the chat switches LS back to it, so a Warhammer 40K chat can draw with a 40K preset (its own style prompt, undesired list, image app and adult-picture routing) while every other chat keeps the normal one.
- **Chats without their own preset** use the default, chosen on the Story tab under the image preset ("Chats without their own preset"). New chats start there, so a new chat never picks up 40K by accident. On updating, the default is the preset in use now.
- Picking a preset with no chat open sets the default.
- Replies also switch: an automatic or manual scan in a chat uses that chat's preset even if the panel never saw the chat open.
- The top bar and the Story tab show where the preset came from: "(this chat)" or "(default)".
- Renaming a preset keeps the chats that use it; deleting one sends those chats back to the default.
