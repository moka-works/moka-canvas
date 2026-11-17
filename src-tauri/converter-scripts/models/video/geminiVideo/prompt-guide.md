# Veo prompt contract

Veo reads one prompt as a description of a single shot: who is in it, what
happens, where, how the camera sees it, how it is lit, and what it sounds
like.

## Shape

Write one paragraph per shot, in this order:

- **Subject** — who or what the shot follows, with the appearance the
  material gives.
- **Action** — what the subject does, in visible beats.
- **Scene** — the place, the time of day, the weather, and the background.
- **Camera** — shot size, angle, lens, depth of field, and one camera
  movement.
- **Light and style** — the light sources, their quality, the palette, the
  mood, and the visual style.
- **Audio** — the effects and ambience, then the score, in sentences of their
  own.

The clip is one continuous shot. Only when the material itself describes a
cut, open each shot as `Shot 1:`, `Shot 2:`, … and keep one camera setup and
one action in each. Do not introduce a cut the material does not have.

## Spoken lines

- A line goes after its speaker and delivery: `The woman says, in a tired
voice: “车已经停运了。”`. Keep the words exactly as written, untranslated.
- Name every speaker by the name the material gives, written in English, and
  keep that name for the whole clip. Alternate turns when the material does.
- Do not repeat a line outside its sentence, and never describe it as a
  subtitle or as text visible on screen.

## Sound

Veo generates the soundtrack with the picture, so describe it in the same
prompt, in sentences of its own:

- **Effects and ambience** — their source, the action, and the space.
- **Score** — its instruments, mood, tempo, and style, when the material has
  one.

When the material has no spoken lines, write no dialogue. Do not write
negative instructions; this prompt names the frame positively, and the
service has a separate place for what it should avoid.

## Pictures given as input

- When the clip starts from a picture, that picture is the opening frame: do
  not describe it again, describe the motion that leaves it.
- When the material gives both ends, describe the move from the opening frame
  to the closing frame as one shot.
- When reference pictures travel instead of frames, number them `Image 1`,
  `Image 2`, … in the order the material gives them, and say what each shows.
  Refer to a person or thing by the picture that carries it, and keep the
  appearance it shows.

## What must not change

Translate and restructure only. Do not add people, props, events, camera
moves, sounds, or lines the material does not contain, and do not drop any
line it does contain.
