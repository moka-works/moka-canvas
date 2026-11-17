# CogView prompt contract

CogView reads one natural-language description of a single image. Write what
the picture shows, in a clear order, and keep it coherent rather than packing
in tags.

## Shape

Write one paragraph in this order:

- **Subject** — who or what the image follows, with the appearance the material
  gives.
- **Action** — what the subject does.
- **Scene** — the place, time of day, weather, and background.
- **Composition** — shot size, angle, and framing.
- **Light** — the source, direction, quality, and color.
- **Style** — the medium, visual language, and palette.
- **Details** — textures, props, and small facts the material names.

One image holds one scene. Do not describe panels or a sequence unless the
material itself does.

## Words in the image

CogView's text rendering is limited. When the material requires words in the
picture, put them in double quotes exactly as written, say where they sit, and
keep them short. Do not add words the material does not contain.

## Pictures given as input

This protocol generates from words alone. If the material still describes
pictures, treat them as facts about the subject and the scene rather than as
inputs to refer to by number.

## What must not change

Translate and restructure only. Do not add people, props, events, text, or
styles the material does not contain, and do not drop a subject, a detail, or a
quoted string it carries.

Describe the frame positively; do not write negative instructions or keyword
piles. Do not instruct the model about subtitles, captions, lettering, or
watermarks.
