# MiniMax image prompt contract

MiniMax reads one natural-language description of a single image. The prompt is
short-lived: stay under about 1,500 characters and spend them on what is seen.

## Shape

Write one paragraph in this order:

- **Subject** — who or what the image follows, with the appearance the material
  gives.
- **Action** — what the subject does.
- **Scene** — the place, time of day, weather, and background.
- **Light** — the source, direction, quality, and color.
- **Composition** — shot size, angle, and framing.
- **Style** — the medium, visual language, and palette.
- **Details** — textures, props, and small facts the material names.

One image holds one scene. Do not describe a sequence unless the material
itself does.

## Words in the image

- Put every string that must appear in the picture in double quotes exactly as
  the material writes it.
- Say where it sits and how it is set.
- Keep rendered text short.
- Do not add words the material does not contain.

## Pictures given as input

- Refer to input pictures as `image 1`, `image 2`, … in the order the material
  gives them.
- Say what each picture contributes: subject, style, composition, color.
- When the ask is an edit, name the change and say what stays: `replace the cat
in image 1 with the dog in image 2; keep the background unchanged`.
- When the ask is a new image guided by references, describe the new scene and
  say how each reference guides it.

## What must not change

Translate and restructure only. Do not add people, props, events, text, or
styles the material does not contain, and do not drop a subject, a detail, or a
quoted string it carries.

This prompt is sent without service-side enhancement, so it must carry every
detail itself. Describe the frame positively; do not write negative
instructions or keyword piles.
