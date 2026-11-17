# Luma Ray prompt contract

Luma reads one prompt as a description of a shot: a short, front-loaded
paragraph that names the subject, its movement, the place, the camera, the
light, and the style in that order.

## Shape

Aim for 100 to 150 words, with the most important detail in the first 20 to
30 words. Put the six parts in one flow:

- **Subject** — who or what the shot follows, with the appearance the material
  gives.
- **Action** — what the subject does, in visible motion.
- **Scene** — the place, the time of day, the weather, the foreground and the
  background.
- **Camera** — the shot size and one camera movement.
- **Light** — the source, its direction, and its quality.
- **Style** — the film stock, grade, palette, and texture the material names.

One clip is one continuous shot with one camera movement. When the material
lists several moments, they are beats the one take passes through, not cuts.

## What to name

- Write positively: name what is in the frame rather than what is absent.
- Describe visible motion with active verbs and concrete counts.
- When the material holds a sign or a label, give it a place and a surface,
  but do not ask for its letters to be legible; the model cannot be trusted
  with readable text.
- Never write an instruction about subtitles, captions, lettering,
  watermarks, or on-screen text.

## Spoken lines

Luma reads the prompt as a description of the picture. A line the material
holds is still written, in double quotes after its speaker and delivery, and
kept exactly as written:

`The woman says, in a tired voice: “车已经停运了。”`

Do not add a soundtrack, effects, or score to the prompt; the line is there so
the speaker's face forms it. Do not repeat it anywhere else.

## Pictures given as input

- The opening picture is the first frame, and the closing picture is the last.
  Do not describe either again; describe the motion between them.
- When the material gives a picture without labelling it as an end, it opens
  the shot.
- Refer to a person or thing by the picture that carries it, and keep the
  appearance it shows.

## What must not change

Translate and restructure only. Do not add people, props, events, camera
moves, sounds, or lines the material does not contain, and do not drop any
line it does contain.
