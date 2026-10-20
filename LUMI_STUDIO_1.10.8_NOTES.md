# Lumi Studio 1.10.8: fixes from six weak pictures

Eric sent six troubleshooting reports. Each fix below is tied to the note on its report.

## Clothes that stuck around ("Siarn pants on knees", "armor should be leather")

- **Temporary states aren't remembered any more.** The chat's memory kept outfits word for word, so "shorts pulled down to knees" from one sex scene, and "ichor-stained wet leather armor" from one fight, followed the characters into every later picture. Memory now keeps the garment and drops the state: wet, soaked, stained, unbuckled, pulled down, open, and similar. That applies to what's already saved too. A state still shows up when the current passage has it.
- **The story's own wardrobe comes first.** These stories keep a list per person (`Siarn · Wardrobe:` / `Layers: … / … / …`). Lumi Studio now reads it, and so does the scene card, ahead of anything remembered. The parser sees it as the current outfit, with the remembered outfit shown only as "earlier detail" for colour and material. In the bunk-room scene the list said "high-cut shorts", while memory still had "shorts pulled down to knees".
- **The parser is told states belong to one moment**, and that a wardrobe list is complete while a scene card line is only a summary.

## Leather armor drawn as metal

- The leather-armor guard now also catches leather chestplates, pauldrons and bracers. It adds "breastplate, metal armor" to the negative prompt, plus "shoulder armor" when nobody wears pauldrons. It checks each item separately, so one person in iron no longer turns it off for everyone.
- Dropping "wet" and "ichor-stained" helps too, since shiny leather reads as steel.

## The extra person in the altar scene ("Extra character")

- The prompt put Eerodet "on the left" and Bruenor "in the center" while she was in his lap, and the picture gave the lap to Siarn instead. Two people joined in a vaginal or anal act no longer get separate left/center/right places. Foreground and background are kept.
- "duplicate, twins" (added in 1.10.4, after these pictures were made) also works against the doubled Siarn.

## Siarn wearing Blark's breastplate ("The armor doesn't make a lot of sense")

- The scene line said Siarn was "cradling Blark's heavy iron breastplate", so the model put it on him. The parser is now told not to name clothing or armor that nobody in the picture is wearing.

## Also fixed

- A scene card's "off-shoulder sweater" came out as "off-shoulder off-shoulder sweater".

## Not changed, worth knowing

- These pictures are 832×512 or 768×576 at 12 steps. Anima is trained around 1024×1024, so at this size faces in wide shots blur together (the "faceless" man in the inn yard) and backgrounds turn to mush.
- Riley's sheet has many near-duplicate tags (three eyewear tags, two piercing sets, two hair-tip tags). Long reference-style tag lists can push the model toward a character-sheet layout, which looks like the "double Riley" panels. Trimming the sheet in LumiCast would help.

## 1.10.9: Pick the size for each picture

A new checkbox in the preset editor, under Width and Height. When it's on, width × height becomes the most LS will use, and each picture gets a share of it based on what's in it:

| Picture | Share of the preset's pixels |
|---|---|
| One person, close-up, portrait, upper body or POV | 55% |
| One person, other framing | 70% |
| One person, full body or wide shot | 80% |
| Two people, close | 75% |
| Two people | 85% |
| Two people in a wide shot, or three or more people | 100% |

The parser's aspect ratio still decides the shape. With 1024×1024 that means, for example: a 3:4 close-up comes out 640×896, two people side by side 1088×832, and three people 1152×896. Drawing time roughly follows the pixel count, so a one-person close-up takes about half as long. Picture details shows the size used and why. It's off by default, and only the new pipeline uses it. Regenerating a picture keeps that picture's size.
