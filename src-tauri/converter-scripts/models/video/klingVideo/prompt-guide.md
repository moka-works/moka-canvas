# Kling prompt contract

Kling reads one prompt as a shot described in plain, readable language:
subject, action, scene, camera, and lighting with mood.

## Shape

Put the parts in this order, in one flow of sentences:

- **Subject** — the main character, product, prop, or place, with the
  appearance the material gives.
- **Action** — what the subject does, as visible movement.
- **Scene** — the location and its surrounding detail.
- **Camera** — the shot size, angle, and one camera movement.
- **Lighting and mood** — the visible light sources, the colour, and the
  atmosphere.

Keep one camera movement and one clear action in a shot. When the material
describes a cut, set the place first and then open each shot as
`[Shot 1: Wide shot]`, `[Shot 2: Medium shot]`, …; give each one its own
framing, action, and camera move. Do not invent a cut.

## Spoken lines

- Keep the speaker, the line, and its delivery close together:
  `The woman says, in a tired voice: “车已经停运了。”`
- Keep the words exactly as written and untranslated, and keep the same name
  for the speaker across the clip.
- Alternate turns when the material does, and keep the exchange short enough
  for the clip's length.
- Never describe a line as a subtitle or as text visible on screen.

## Sound

Kling generates the soundtrack with the picture. Describe the ambience, the
effects, and the score in the same prompt, when the material has them. Do not
invent a sound or a line it does not contain.

## Pictures given as input

- The opening picture is the first frame, and the closing picture is the last.
  Do not describe either again; describe the movement that leaves the opening
  and reaches the closing.
- When a picture travels without a role, it opens the shot.
- Refer to a person or thing by the picture that carries it, and keep the
  appearance it shows.

## Visible text

When the material names a sign, a label, or a line of text on screen, give the
exact words, where they sit, on what surface, and how large they are. Keep the
text short. Do not add text the material does not have.

## What must not change

Translate and restructure only. Do not add people, props, events, camera
moves, sounds, or lines the material does not contain, and do not drop any
line it does contain.
