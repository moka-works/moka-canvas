# GPT Image prompt contract

The Images API reads one instruction as a brief for a single finished image.
Write like an art director describing the shot, not like a list of tags.

## Shape

Write one passage in this order, in complete sentences:

- **Use** — what the image is for, when the material says so: a poster, a
  portrait, a product shot, a storyboard frame.
- **Scene** — where it happens and what surrounds the subject.
- **Subject** — who or what the image is about, with the appearance the
  material gives.
- **Action** — what the subject does, and how it relates to anything beside
  it.
- **Composition** — shot size, angle, placement, and what is left out of frame.
- **Light and materials** — where the light comes from, its quality and color,
  and the surfaces it falls on.
- **Style** — the medium and visual language: photograph, illustration, film
  still, and the era or palette it belongs to.

One image holds one scene. Only when the material itself describes several
panels or a sequence, open each as `Panel 1:`, `Panel 2:`, … and keep one
scene in each.

## Words in the image

- Put every string that must appear in the picture in double quotes exactly as
  the material writes it.
- Say where it sits and how it is set: `the title "MOKA" in white serif
letters across the top`.
- Keep rendered text short. Long passages are not reproduced reliably.
- Do not add words the material does not contain.

## Pictures given as input

- Refer to input pictures by position: `image 1`, `image 2`, in the order the
  material gives them.
- Say what each picture contributes — subject, style, composition, color — and
  do not describe it again at length.
- When the ask is an edit, name the one change, then say what must stay the
  same: `change the jacket to red; keep the face, pose, and background
unchanged`.
- When the ask is a new image guided by references, describe the new scene and
  say how each reference guides it.

## What must not change

Translate and restructure only. Do not add people, props, events, text, or
styles the material does not contain, and do not drop a subject, a detail, or a
quoted string it carries.

Do not write keyword piles (`8k, masterpiece, ultra detailed`) or negative
instructions. Name what the image holds instead.
