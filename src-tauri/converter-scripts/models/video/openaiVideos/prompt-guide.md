# Sora 2 prompt contract

Sora reads one prompt as a brief to a cinematographer who has never seen the
storyboard: a description of the shot, followed by the few labelled blocks
that make its camera, timing, dialogue, and sound explicit.

## Shape

Open with a prose description of the shot: the style and look, the scene, the
subject and wardrobe, the weather and time of day, and the light. Then give:

```text
Cinematography:
Camera shot: <framing and angle>
Depth of field: <what stays sharp, what falls away>
Lighting and palette: <sources, quality, three to five colours>
Mood: <the tone>

Actions:
- <one visible beat>
- <the next beat>

Dialogue:
- <Name>: "<line, exactly as written>"

Background Sound:
<ambience and effects; the score, when the material has one>
```

One shot holds one camera setup, one subject action, and one lighting recipe.
When the material describes a cut, give each shot its own block, opening with
`Shot 1:`, `Shot 2:`, … and keep each one self-contained. Do not invent a cut.

## Actions

Describe action in beats a camera can see — steps, gestures, pauses — rather
than as a summary. Keep the beats the material gives, in its order, and give
them the pace it names. Do not add an action it does not contain.

## Spoken lines

- Put each line in the `Dialogue` block, one bullet per line, after the
  speaker. Keep the words exactly as written and untranslated.
- Label every speaker by the name the material gives, written in English, and
  keep that label for the whole clip. Alternate turns when the material does.
- Keep the exchange short enough for the clip: one or two short lines in a
  four-second shot, a few more in a longer one.
- Do not repeat a line outside the `Dialogue` block, and never describe it as
  a subtitle or as text visible on screen.

## Sound

`Background Sound` carries the ambience, the effects, and the score when the
material has one. When the material holds no spoken lines, leave the dialogue
block out; when it holds no score, describe only what is heard. Never write an
instruction about subtitles, captions, lettering, watermarks, or on-screen
text.

## Pictures given as input

- When the clip starts from a picture, that picture anchors the first frame.
  Describe what moves out of it; do not describe the picture again.
- When the material gives both ends, describe the action that carries the
  opening frame to the closing one.
- When the clip is built from reference pictures rather than frames, number
  them `reference image 1`, `reference image 2`, … in the order the material
  gives them, say what each shows, and keep the appearance it carries.

## What must not change

Translate and restructure only. Do not add people, props, events, camera
moves, sounds, or lines the material does not contain, and do not drop any
line it does contain.
