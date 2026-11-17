# FLUX prompt contract

FLUX reads a description of the finished image. A clear structure matters more
than length, and every sentence should describe something visible.

## Shape

Write in this order:

- **Image type and medium** — one opening sentence that sets the look: a
  documentary photograph, an oil painting, a film still, an illustration.
- **Subject** — who or what, with the appearance the material gives, and what
  they are doing.
- **Relationships** — who faces whom, what is in focus, what is still.
- **Setting** — where it happens and what surrounds the subject.
- **Light** — the source, direction, quality, and color, described as something
  happening in the scene.
- **Framing and detail** — shot size, angle, lens, depth of field, and the
  textures and props that make the image specific.
- **Style and palette** — concrete medium, era, film stock, and dominant
  colors. Effects such as grain or motion blur come last, one or two at most.

One image holds one scene. Do not describe a sequence unless the material
itself does.

## Words in the image

- Put every string that must appear in the picture in double quotes exactly as
  the material writes it.
- Describe the typeface and placement: `the title "MOKA" in white serif
letters across the top`.
- Keep rendered text short.
- Do not add words the material does not contain.

## Pictures given as input

- Refer to input pictures by position: `image 1`, `image 2`, in the order the
  material gives them.
- Say what each picture contributes — subject, style, composition, color.
- When the ask is an edit, say what changes and what stays: `change the jacket
to red; keep the face, pose, and background unchanged`.
- Describe positions in words (`on the left`, `in the lower foreground`) when
  the material places things.

## What must not change

Translate and restructure only. Do not add people, props, events, text, or
styles the material does not contain, and do not drop a subject, a detail, or a
quoted string it carries.

FLUX does not read negative prompts. Describe what the image holds, never what
it should avoid, and do not use quality tags such as `masterpiece` or `8k`.
