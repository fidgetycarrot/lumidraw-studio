# Lumi Studio 1.15.2: Smarter specific-garment matching

When a scene card or story passage uses a short garment phrase (such as `"ruined coat"`, `"storm-grey power armor"`, or `"helmet"`), `simpleKeepSpecific` now restores the fuller garment description from the character sheet more reliably without touching the parser prompt:

- **Garment head word before prepositions:** Sheet tags with trailing details (`"crimson silk officer coat on shoulders"`, `"helmet with glowing amber eye-lenses"`, `"power armor with bronze-runed pauldrons"`) now match by their main garment noun (`coat`, `helmet`, `armor`) rather than only their final word.
- **Condition prefixes preserved:** Condition words on incoming story tags (`ruined`, `torn`, `ripped`, `tattered`, `damaged`, `wet`, `soaked`, `damp`, `stained`, `bloodied`, `muddy`, `dusty`, `grimy`) no longer prevent matching the base garment on the sheet, and stay attached (`"ruined coat"` + `"crimson silk officer coat"` → `"ruined crimson silk officer coat"`).
- **Hyphenated and 4-word garment phrases:** Raised the incoming word cap from 3 to 4 so hyphenated colour phrases like `"storm-grey power armor"` still upgrade to fuller sheet descriptions.
- **Sheet edits carry into active chats:** If per-chat memory holds a shorter version of the exact same garment on the sheet, the fuller sheet description upgrades it automatically.
