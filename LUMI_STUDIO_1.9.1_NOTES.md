# Lumi Studio 1.9.1 (staging): settings in one place each

Layout only. The backend has not changed since 1.9.0.

## Story: one scroll, no sub-tabs
1. **Story pictures**: Scan latest, Choose old message, and the status line.
2. **This chat**: cast, playing as, add a saved character, main-two and
   fantasy switches, and **what Lumi Studio remembers in this chat** (looks,
   clothes, place, with Refresh and Forget). This refreshes whenever you open
   the Story tab.
3. **When to draw**: image preset, mode, how often, **Use the simple pipeline**,
   pictures per reply, people per picture. Two rarely used switches sit under
   *More options*.
4. **Prompt**: quality tags, negative, prefix, banned, starting place, and the
   Anima artist list.
5. **Last picture**: the prompt sent, what the parser returned, and a
   Troubleshooting report button.

## Settings: five tabs
- **Image apps**: SwarmUI, Draw Things (plus the settings it refused), Bridge,
  and Draw Things cloud.
- **Parser**: connection, model, temperature, earlier messages, loomledger, and
  Advanced.
- **Chat pictures**: width, smaller previews, and deleting pictures with a chat.
- **Help & reports**: restore images, diagnostics, and the reports.
- **Old pipeline (1.8)**: scene core, Jev planner, BREAK, the Jev key and
  settings, clothing tracking (sync/review), the story memory status and report,
  and Inline mode instructions. Everything is grouped and visible, so the two
  pipelines can be compared.

Labels are reworded in plain words (for example "Most people in one picture" and
"Direct — only when I press Scan").

## Checked
- All 252 controls are present before and after (same classes and actions),
  and none are lost or duplicated. Controls were moved, not rebuilt, so their
  existing save/load code is unchanged.
- Toggling *Use the simple pipeline* and *loomledger* in their new places sends
  `save_settings` with the new values.
- Every tab loaded in headless Chromium with no page errors, at 1280 px and at
  phone width (390 px) with no sideways scrolling.
- Not yet run inside a live Lumiverse.
