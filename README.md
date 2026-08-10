# LumiDraw Studio 0.42.5

Includes everything in 0.42.4 — install this one instead.

## The dropdown is the model. The field is the exception.

That was already true in 0.42.4 under the hood: an empty override means the
connection's own model runs, no clicking required. What made it feel convoluted was
the **Use connection model** button sitting next to the field, implying you had to
accept the dropdown's choice. It's gone.

Copying the connection's model into the override was never useful — it produced a
value identical to the default, and that redundant value is exactly the state that
made switching connections silently do nothing.

### What the panel does now

| Field state | What runs | What the note says |
|---|---|---|
| Empty (normal) | The connection's model | *Using moonshotai/kimi-k3 from the connection.* |
| Something typed | What you typed | **Override in effect — requests go to "X", not the connection's "Y". Switching connections will not change the model until you clear this.** |
| Typed, same as connection | Same thing either way | **This is already the connection's model — clearing it changes nothing except that switching connections will work again.** |

- Label is now **Model override (leave empty)**.
- Placeholder reads *"leave empty to use the connection's own model"*, and once a
  connection is selected it names that model.
- **Clear** is hidden until there is something to clear.
- Any value in the field colours the note amber. An empty field reads as normal
  text, because empty is the correct state.

37 suites' worth of coverage held: 973 assertions, all green.
