# Lumi Studio 1.35.0

## Caption

A new Caption section (tab next to Library) describes a picture with a model
that can see images, using prompts you save and name.

- Picture: choose a file, drop one on the box, or click one of your recent
  Lumi Studio pictures. In the picture viewer, Details → "Caption this" sends
  that picture here.
- Prompt: pick a saved prompt from the list and edit the text. "Save" updates
  the one you are on, "Save as new" asks for a name, "Delete" asks once more
  before deleting. Comes with three you can change or delete: Style,
  Character and Plain description.
- Model: its own connection and model, because the parser model may not see
  pictures. Empty means the parser's connection.
- Result: a box with Copy, and "Use in Studio" puts it into Studio's prompt.

Pictures are shrunk to at most 1536 pixels and sent as JPEG; the models shrink
them anyway. Uses Lumiverse's own image support in generation, so any vision
model on a connection you already have works.

Checked in a browser with a fake backend (choosing a file, saving, a new
prompt, deleting, running, Use in Studio) and the backend part with a fake
model. Not yet run against a real model.

# 1.35.1

Caption has a box for what you already know about the picture ("the person is
a femboy, not a woman"). It is sent before the prompt as fact, and the model
is told to build its answer around it even where the picture is unclear. It
clears when you pick another picture.
