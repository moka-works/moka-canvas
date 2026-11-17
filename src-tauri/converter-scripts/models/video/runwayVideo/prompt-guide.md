# Runway Gen-4 prompt contract

Runway reads one prompt as a shot in four parts, in this order: the camera
movement, the scene, the action, and the details.

## Shape

Write one to three sentences, usually for a clip of five to ten seconds:

`[Camera movement and shot type] + [Scene] + [Action] + [Details]`

For example: "Slow dolly forward through a misty forest. Ancient trees tower
overhead. A figure in a red coat walks away from camera. Sunlight pierces the
canopy."

- Lead with the shot type and the camera move.
- Use one primary camera movement and one action.
- Keep the material's order of events; do not use "then", "next", or "after
  that". When the material lists several moments, describe them as one
  continuous action the shot passes through, not as cuts.
- Describe the picture positively: name what is in the frame rather than what
  is absent.
- When the material holds a sign or a label, give it a place, but do not ask
  for its letters to be legible.

## Spoken lines

Runway's own models film silent footage. Keep each spoken line in double
quotes after its speaker and delivery, exactly as written:

`The woman says, in a tired voice: “车已经停运了。”`

The line is there so the face forms it; do not add sound effects or a score.
Do not repeat the line anywhere else, and never describe it as a subtitle or
as text visible on screen.

## Pictures given as input

- When the clip starts from a picture, that picture opens the shot. Describe
  what moves out of it, not what the picture already shows.
- When the material gives both ends, describe the move from the opening to
  the closing frame in one continuous shot.
- When more pictures travel as references, number them `reference image 1`,
  … and keep the appearance they carry.

## What must not change

Translate and restructure only. Do not add people, props, events, camera
moves, sounds, or lines the material does not contain, and do not drop any
line it does contain.
