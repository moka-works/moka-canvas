# MiniMax-H3 prompt contract

The model reads one prompt written as three named sections. Anything outside
these sections is not part of the contract.

```text
integrated_multimodal_description: <English narration and spoken lines>

overall_soundscape: <English ambience, effects, and non-verbal voices; or N/A>

non_diegetic_music: <English score description, or N/A>
```

## Narration

- Write the narration in English. It is the only language the body may be in.
- Describe people, places, light, framing, and action positively: say what is
  there rather than what is not.
- `[Shot 1]` carries no timestamp. Each later shot opens with
  `At 00:SS.mmm, the camera cuts to …`, the time strictly increasing and
  inside the clip's length.
- Do not repeat a spoken line anywhere outside its `<d>` block.

## Spoken lines

- A line that is spoken goes inside `<d>` and nowhere else:
  `<d>[Chinese] 台词原文</d>`. The language tag names the language of the line
  as it is spoken; keep the words exactly as written, untranslated.
- The speaker and the way the line is delivered stay outside `<d>`:
  `A cold, mechanical public-address voice (S1) says: <d>[Chinese] …</d>`.
- Give every speaking character one stable id, `(S1)`, `(S2)`, and keep it for
  the whole clip. Do not give an id to anyone who does not speak. Two people
  speaking at once are `(S1,S2)`.
- Never wrap a spoken line in quotation marks. In this contract, double quotes
  mean text that is visible in the picture — a sign, a screen, a label — so a
  quoted line is read as a subtitle and is burned into the frame.
- A voice heard without the speaker on screen says
  `says in an off-screen voiceover`, and the picture adds
  `lips remain completely closed`. Do not invent negative instructions such as
  "do not speak" or "mouth stays shut".
- Never write instructions about subtitles, captions, lettering, watermarks, or
  on-screen text. The contract has no negative branch; naming a thing to
  exclude introduces it. Say what the frame holds instead.

## Sound

- `overall_soundscape` carries ambience, physical sounds, and non-verbal
  voices. It never repeats a spoken line.
- `non_diegetic_music` carries the score, or `N/A` when there is none.

## Pictures given as input

When the material says the clip starts from a picture, open the prompt with
the alignment sentence before `integrated_multimodal_description`:

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
```

When it gives both a first and a last picture:

```text
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the end mark of the target video.
```

When the clip is built from reference pictures rather than frames, number them
in the order the material gives them — `<Picture 1>`, `<Picture 2>`, … — and
say what each one shows. Refer to a person or thing by the picture that carries
it, and keep the appearance and clothing that picture shows.

Refer to an input picture as `<Picture N>` in the narration, and keep the
person and place as the picture shows them.

## What must not change

Translate and restructure only. Do not add people, props, events, camera
moves, sounds, or lines that the material does not contain, and do not drop
any line it does contain.
