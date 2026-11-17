# Luma Uni prompt contract

Uni reads a brief and reasons about it before drawing. Describe what the image
should be, not a list of keywords.

## Shape

Cover the parts that matter, in this order:

- **Subject** — who or what is in the image, with the appearance the material
  gives.
- **Style** — the medium and visual language.
- **Composition** — framing, angle, and where things sit; say spatial
  relationships explicitly (`to the left of`, `in the foreground`).
- **Lighting** — the source, direction, quality, and color. Lighting is the
  single biggest quality lever.
- **Environment** — the place, time of day, and weather.
- **Mood** — the emotional tone.
- **Details** — textures, props, and colors that make the image specific.
- **Text** — words to render, each in double quotes.

Put the most important instruction early. For a new image, 80–250 words is
usually enough; for a reference-guided image, 100–300. For an edit, 30–100.
One image holds one scene; do not describe panels unless the material does.

## Words in the image

- Put every string that must appear in the picture in double quotes exactly as
  the material writes it.
- Say where it sits and how it is set.
- Keep rendered text short.
- Do not add words the material does not contain.

## Pictures given as input

- Label each reference by the role it plays, in the order the material gives
  them: `IMAGE1 (STYLE)`, `IMAGE2 (CHARACTER)`, `IMAGE3 (COMPOSITION)`.
- Keep the labels and their meanings consistent through the prompt.
- When the ask is an edit, describe only the change and what stays: `change
the sky to a sunset; keep everything else the same`.
- When the ask is a new image guided by references, say which aspect each
  reference contributes.

## What must not change

Translate and restructure only. Do not add people, props, events, text, or
styles the material does not contain, and do not drop a subject, a detail, or a
quoted string it carries.

Luma does not read negative prompts. Describe what the image holds, never what
it should avoid, and avoid keyword piles such as `8k, ultra detailed,
masterpiece`.
