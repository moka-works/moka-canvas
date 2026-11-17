# Seedance prompt contract

Seedance reads one prompt as a set of directions to a director who builds the
shot in two layers: what the frame holds and how it changes over time.

## Shape

Put these in this order, in one flow:

- **Subject** — the precise subject, with two or three stable features
  (clothes, hair, appearance, category) that make it recognizable.
- **Action** — the body detail, its amplitude, speed, and force, and how one
  movement leads into the next.
- **Scene** — the place, its foreground and background, the time of day, and
  the weather.
- **Light and colour** — the sources, the quality, and the palette.
- **Camera** — the shot size, the angle, and one camera movement.
- **Style and quality** — the visual style, the texture, and the quality the
  material names.

## Shots

A clip may hold several shots. When the material describes a cut, set the
place first and then open each shot as `Shot 1:`, `Shot 2:`, … in the order
the events happen. Each shot carries its own camera move, action and
expression, position, and audio. Do not give a shot a timestamp; this model
takes its pace from the events. When the material describes one continuous
take, do not invent a cut.

## Spoken lines

- A spoken line goes inside curly braces: `The woman says {车已经停运了。}`.
  Keep the words exactly as written and untranslated.
- Keep the speaker and the line together, and keep the same name for the
  speaker across the clip. Alternate turns when the material does.
- Do not repeat a line outside its braces, and never describe it as a
  subtitle or as text visible on screen.

## Sound

Seedance generates the soundtrack with the picture. Describe the ambience,
the effects, and the score in the same prompt, when the material has them,
either inside the shot they belong to or in one closing sentence. Do not
invent a sound or a line the material does not contain.

## Pictures given as input

- When the clip starts from a picture, that picture is the opening frame: do
  not describe it again, describe the motion that leaves it.
- When the material gives both ends, describe the move from the opening frame
  to the closing frame as one shot.
- When pictures travel as references, number them `<Image 1>`,
  `<Image 2>`, … in the order the material gives them, and define each subject
  by the picture that carries it: `the woman in <Image 1>`. Keep the
  appearance and clothing the picture shows, and use the same name for the
  subject afterwards.

## What must not change

Translate and restructure only. Do not add people, props, events, camera
moves, sounds, or lines the material does not contain, and do not drop any
line it does contain. Name what the frame holds rather than what it must
avoid.
