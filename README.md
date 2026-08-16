# LumiDraw Studio 0.90.0 — persona, second route

0.89 asked the host for the chat's persona via `spindle.personas`. LumiDraw's own
host probe contains a line asking whether that API exists at all, which means
past me wasn't sure either — and if it doesn't exist, 0.89 silently fell back to
the cast. Which is Jason.

**Now it tries two routes:** the host first, then your own persona library,
matched by id *or* by name. One of them will have Elliot.

If neither does, the cast still answers — nothing gets worse.

## Tell me which line you get

After installing, press **↻** in the wardrobe section. That alone resolves the
leads and logs one of four lines:

| log line | meaning |
|---|---|
| `persona comes from the chat: Elliot` | working |
| `persona resolved from your own library: Elliot` | working, via the new route |
| `the chat names persona <id> but it could not be read` | the id is there, neither route resolved it — send me the id |
| `the chat DTO names no persona. Keys: …` | the chat doesn't carry one — **send me those keys** |

The last one is the one I need most. It prints the real field names of your chat
object, and I'll add whichever one holds the persona.

**58 suites · 2,610 assertions · all green.**
