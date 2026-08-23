# LumiDraw Studio 1.3.7 — chat-local Cast & Wardrobe

- Cast and Wardrobe now rehydrate every time Lumiverse switches chats; stale rows are cleared immediately while the new chat loads.
- Frontend cast/wardrobe requests capture the chat id they were made for and ignore late replies from a chat you already left.
- Backend Cast/Wardrobe handlers now trust an explicit LumiDraw chat id before the host active-chat fallback, preventing the previous chat from winning during a switch race.
- New/unbound chats no longer auto-adopt legacy people stored in the generation preset. Preset identity fields remain stored for rollback/migration but are not active story state.
- Unbound chats use the active Lumiverse character/persona (when readable) plus any characters explicitly added for that chat.
- The first cast edit in an unbound chat creates a small chat-local cast instead of mutating the generation preset.
- Existing chat→cast bindings are not rewritten. If 1.3.6 already auto-bound a brand-new chat to an old migrated cast, choose “(none — use this chat only)” once to release that existing binding.
- LumiDraw 1.3.5+ native image mounting/anchoring is unchanged. Direct-mode 1.3.6 prompting/continuity changes are unchanged.
