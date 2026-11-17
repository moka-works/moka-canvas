# CogVideoX prompt contract

CogVideoX reads one prompt as a single paragraph: the camera and light, the
subject, the motion, the scene, and the atmosphere, in that order.

## Shape

Use this order in one flow of sentences:

- **Camera and light** — the shot size, the angle, one camera movement, and
  the light source and quality.
- **Subject** — who or what carries the shot, with the appearance the
  material gives.
- **Motion** — what the subject does, with the body detail, force, and pace
  the material gives.
- **Scene** — the place, its foreground and background, and the time of day.
- **Atmosphere** — the colour, the mood, and the visual style.

The clip is one continuous shot. When the material lists several moments,
they are moments the shot passes through, not cuts. Do not introduce a cut
the material does not have.

## Spoken lines

- Keep the line after its speaker and delivery:
  `The woman says, in a tired voice: “车已经停运了。”`
- Keep the words exactly as written and untranslated.
- Name every speaker by the name the material gives, written in English, and
  keep that name for the whole clip. Alternate turns when the material does.
- Do not repeat a line outside its sentence, and never describe it as a
  subtitle or as text visible on screen.

## Sound

CogVideoX generates the soundtrack with the picture when the model is asked
for it. The prompt describes the picture; keep a spoken line in quotes after
its speaker, and leave the score and effects to the model. Do not invent a
sound or a line the material does not contain.

## Pictures given as input

- When the clip starts from a picture, that picture is the opening frame: do
  not describe it again, describe the motion that leaves it.
- When the material gives both ends, describe the movement from the opening
  frame to the closing frame as one shot.
- When more pictures travel, refer to the one that anchors the shot, and keep
  the appearance it shows.

## What must not change

Translate and restructure only. Do not add people, props, events, camera
moves, sounds, or lines the material does not contain, and do not drop any
line it does contain.
