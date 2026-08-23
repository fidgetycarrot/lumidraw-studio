# LumiDraw Studio 1.3.8

Hotfix for a launcher-loss state observed after updating to 1.3.7.

- Keeps all 1.3.7 chat/cast/wardrobe fixes.
- If a live LumiDraw panel survives a Lumiverse hot reload but its launcher does not, a recovery launcher is recreated instead of the duplicate-instance guard silently returning.
- Live instances now record their version and cleanup callback, allowing future hot reloads to tear down an older LumiDraw instance cleanly before mounting the new one.
- An orphan launcher without a panel is removed so a complete UI can mount.
- Backend behavior is unchanged from 1.3.7.
