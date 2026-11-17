# Wan 3.0 prompt contract

Wan 3.0 reads one prompt as a single description of the clip: the subject,
the scene, the motion, the camera and light, the style, and what it sounds
like. Write it in English, as connected prose, without section headers.

## Shape

Put these in this order, in one flow of sentences:

- **Subject** — who or what carries the clip, with the appearance the material
  gives: age, build, clothes, features.
- **Scene** — the place, its foreground and background, and the time of day.
- **Motion** — what the subject and the world do, with the pace and force the
  material gives them.
- **Camera and light** — shot size, angle, camera move, light, colour, and
  style.
- **Sound** — spoken lines, effects and ambience, and the score.

The model weighs a concrete, positive description of what is in the frame; it
has no separate negative branch, so name what is there rather than what is
absent.

## One shot

The clip is one continuous shot. Open the prompt with `Generate single shot.`
and keep the whole clip in one take, even when the material lists several
moments: they are moments the shot passes through, not cuts.

Only when the material itself describes a cut between shots, write the clip
whole in one sentence first, then open each shot as `Shot N [a-bs]`, for
example `Shot 2 [3-6s]`, with the times strictly increasing and inside the
clip's length. Do not introduce a cut the material does not have.

## Spoken lines

- A spoken line goes inside double quotes, after the speaker and the way it is
  delivered: `The woman says, in a tired voice: “车已经停运了。”`.
- Keep the line exactly as written, untranslated, in the language it is spoken.
- Do not write a line anywhere outside its quotes, and never describe it as a
  subtitle or as text visible on screen.
- Name each speaker with the name the material gives, written in English, and
  keep that name for the whole clip. Never invent a speaker.
- When the material has no spoken lines, end the sound description with
  `No dialogue.` Do not write it when a line is spoken.

## Sound

Wan 3.0 generates the soundtrack with the picture, so describe it in the same
prompt:

- **Voice** — the line's emotion, tone, pace, timbre, and accent, written
  beside the quote.
- **Effects and ambience** — their source, the action, and the space they
  happen in.
- **Score** — its instruments, mood, tempo, and style.

When the material has no score, end with `No background music.` Do not invent
a score, an effect, or a line the material does not contain.

## Pictures given as input

- When the clip starts from a picture, that picture is the opening frame: do
  not describe it again, describe the motion that leaves it.
- When the material gives both ends, describe the move from the opening frame
  to the closing frame as one shot.
- When the clip is built from reference pictures rather than frames, number
  them `Image 1`, `Image 2`, … in the order the material gives them, and say
  what each one shows. Videos are `Video 1`, … and audio is `Audio 1`, …;
  images, videos, and audio are counted separately. Refer to a person or thing
  by the picture that carries it, and keep the appearance it shows.

## What must not change

Translate and restructure only. Do not add people, props, events, camera
moves, sounds, or lines the material does not contain, and do not drop any
line it does contain.
