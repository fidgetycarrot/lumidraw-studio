# LumiDraw Studio 1.3.9

Startup-diagnostic hotfix built on 1.3.8.

- Creates a raw-DOM bootstrap launcher as the first action in `setup()`, before Spindle DOM helpers, backend subscriptions, styles, Cast, or image code.
- If normal startup succeeds, the bootstrap launcher disappears and the ordinary LumiDraw launcher remains.
- If normal startup throws, the bootstrap launcher stays visible in red; clicking it shows the exact startup error.
- If even the bootstrap launcher does not appear, Lumiverse did not import/call LumiDraw's frontend module, narrowing the problem to extension loading rather than LumiDraw runtime code.
- `ctx.dom.addStyle()` now gracefully falls back to a normal `<style>` node if the host helper throws (for example because an `app_manipulation` grant is stale/missing) instead of aborting startup before the UI exists.
- Backend and all 1.3.7 Cast/Wardrobe isolation, 1.3.6 Direct pipeline, and 1.3.5 native image mounting behavior are unchanged.
- The ordinary LumiDraw launcher/panel now use a much higher top-level z-index as well. This rules out a newer Lumiverse shell layer simply painting the button underneath the app after the recent frontend changes.
