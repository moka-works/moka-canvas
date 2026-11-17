# Seedream prompt contract

Seedream reads a coherent natural-language description. Write complete
sentences about the subject, what it does, and where it is; add the aesthetic
parts only where they matter.

## Shape

Write in this order:

- **Subject and behaviour** — who or what, with the appearance the material
  gives, and what they are doing.
- **Environment** — the place, time of day, weather, and background.
- **Light** — the source, direction, quality, and color.
- **Composition** — shot size, angle, and where the subject sits.
- **Style and palette** — the medium, visual language, and dominant colors.
- **Details** — textures, props, and small facts the material names.

When the material states what the image is for, say so early: a poster, a logo,
a storyboard frame, a product shot.

One image holds one scene. Do not describe a sequence unless the material
itself does.

## Words in the image

- Put every string that must appear in the picture in double quotes exactly as
  the material writes it.
- Say where it sits and how it is set.
- Keep rendered text short; long passages are not reproduced reliably.
- Do not add words the material does not contain.

## Pictures given as input

- Refer to input pictures as `图1`, `图2`, … in the order the material gives
  them.
- Say what each picture contributes: subject, style, background, composition.
- When the ask is an edit, name the change in terms of the input pictures and
  say what stays: `参考图1，把外套改成红色，保持人物、姿势和背景不变`.
- When the ask is a new image guided by references, describe the new scene and
  say which picture guides which part of it.

## What must not change

Translate and restructure only. Do not add people, props, events, text, or
styles the material does not contain, and do not drop a subject, a detail, or a
quoted string it carries.

Describe the frame positively; do not write negative instructions or keyword
piles. Do not instruct the model about subtitles, captions, lettering, or
watermarks.
