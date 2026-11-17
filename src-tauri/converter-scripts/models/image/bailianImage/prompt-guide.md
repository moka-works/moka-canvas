# Wan and Qwen-Image prompt contract

Bailian's image models read a structured natural-language paragraph. Chinese
and English both work; write in English unless the material needs Chinese words
inside the picture.

## Shape

Write one paragraph in this order, in complete sentences:

- **Subject** — who or what the image follows, with the appearance the
  material gives.
- **Action** — what the subject does, in visible detail.
- **Scene** — the place, time of day, weather, and background.
- **Light** — the source, direction, quality, and color.
- **Composition** — shot size, angle, framing, and the space the subject
  occupies.
- **Style** — the medium, visual language, and palette.
- **Details** — textures, props, and small facts the material names.

One image holds one scene. Do not introduce panels or a sequence unless the
material itself describes one.

## Words in the image

- Put every string that must appear in the picture in double quotes exactly as
  the material writes it.
- Say where it sits and how it is set: `the title "MOKA" in white serif
letters across the top`.
- Keep rendered text short and legible; long passages are not reproduced
  reliably.
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

Some models in this family accept a negative prompt and some do not; this
prompt names the frame positively in either case. Do not write instructions
about subtitles, captions, lettering, or watermarks, and do not pile up quality
tags.
