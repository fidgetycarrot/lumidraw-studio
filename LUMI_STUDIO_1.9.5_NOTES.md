# Lumi Studio 1.9.5 (staging): a vaguer word no longer changes clothes

**What happened (report from 2026-10-13 16:08):** the story model's scene card
said `Armor, breeches hastily fastened`. The parser copied that, so the prompt
said only "armor" where Lumi Studio already knew "leather armor". Anima reads
bare "armor" as plate.

**Fix, in two places:**
- **Parser instruction:** "A vaguer word is not a change. If CURRENT OUTFIT
  says 'leather armor' and the passage or scene card just says 'armor', write
  'leather armor'."
- **Safety net in the prompt builder:** if the parser names a garment with
  fewer words than one Lumi Studio already knows (same item, nothing new added),
  the known version is used. It checks the chat's remembered outfit first, then
  the sheet's default outfit. Old state words such as "unfastened" are not
  carried over, so a real change still comes through. The troubleshooting
  report says when this happened: *Bruenor: kept "leather armor" — the story
  only said "armor".*

| Story says | Known | Result |
|---|---|---|
| armor | road-worn leather armor | road-worn leather armor |
| armor | Leather armor (sheet default) | leather armor |
| breeches | unfastened breeches | breeches (the state changed) |
| robe | open moss-green robe | moss-green robe |
| open robe | closed moss-green robe | open robe (different state) |
| heavy armor | leather armor | heavy armor (new detail, the story wins) |
| armor | leather armor *and* plate armor | armor (unclear, the story's word stays) |
| nude | leather armor | nude |

Replayed the 16:08 report's real parser reply: Bruenor now gets "leather
armor" (sheet default only) or "road-worn leather armor" (with remembered
clothes). The earlier end-to-end scan and re-parse tests still pass.
