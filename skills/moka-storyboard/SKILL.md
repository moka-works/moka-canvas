---
name: moka-storyboard
description: Batch-produce one Moka Canvas chapter from storyboard to finished pictures, clips, voices and score, with human review at a few batch checkpoints. Use when the user asks to 分镜, 故事板, 批量出图/出片/配音, or take a chapter to a state ready for editing.
---

# Moka Storyboard Autopilot

Take one chapter of a Moka Canvas story from its words to a board whose shots
all have pictures, clips, readings and a score — with the reader approving the
board, the frames and the clips in batches. The room stays the place where the
work is seen and judged; this skill is how an agent keeps it supplied.

Speak to the reader in the language they used. Every command below is run with
`--json`, and every write is made through `moka`. Read `moka-canvas` first for
the tool conventions; this skill adds the chapter workflow on top.

## 1. What the reader gets

The run is finished when, for the chosen chapter:

- every act has shots and the board is applied;
- every character, place and thing the chapter uses has its picture;
- every shot has a current frame (`art`), unless it was said to need none;
- every act or shot that is filmed has a current clip, following the story's
  shot granularity;
- every spoken line has a current reading;
- every act whose sound describes music, effects or ambience has a score;
- `story.board_report` and `story.dubbing_report` show no missing work, or the
  reader has explicitly accepted what remains.

The reader approves three things, and only three, unless they ask for more:
the board, all the frames together, and all the clips/voices/score together.
Do not ask once per shot, once per act or once per job.

## 2. One applier

A story job's answer must land **exactly once**:

- If the Moka app has the story room open, the room reads the story's jobs and
  writes unread answers into the document itself. Leave it to the room.
- If the app is not open, this skill stops and asks the reader to open the
  story room, rather than applying the answer through the CLI as well. Two
  appliers turn a frame into two takes and a text answer into a second write.

The room's slow look finds jobs started outside it; the reader only has to
open the story and leave it open. To check progress, read the document, never
the agent's own idea of what it started.

## 3. Setup — one question, then go

```bash
moka --version
moka doctor --json
moka --project <PROJECT> projects current --json
moka --project <PROJECT> tools call story.list --json
```

Find the story and chapter. If the story or chapter is ambiguous, stop and ask;
never pick the first one. Then read it whole:

```bash
moka --project <PROJECT> tools call story.get --input '{
  "storyId": "<STORY_ID>",
  "chapterId": "<CHAPTER_ID>",
  "fullText": true,
  "include": ["brief", "chapters", "elements", "storyboard", "progress"]
}' --json
```

Check `confirmedSteps` and `progress`. If `idea`, `outline` or `elements` is not
confirmed, stop and say which one is missing. The board is written from the cast
on file; an unconfirmed cast is not a cast to draw from. Do not invent a cast,
and do not confirm a step for the reader.

Ask **one** batch question before spending anything:

- Which text model writes the board? (`project.describe_models` with
  `capability: "text"`)
- Which image model draws the cast and frames?
- Which video model films the clips, and what is its clip window?
- Which speech model reads the lines?
- Which music model writes the score?
- If the chapter already has a board: replace it, keep it and fill the gaps, or
  stop?
- Should an act plan be written before the board, or should the board write its
  own acts?

If the reader says “use the defaults”, use each capability's default from
`project.describe_models`. Record the model ids actually used; a later report
that omits them is not a report.

## 4. The board

Optional act plan, when the reader asked for one:

```bash
moka --project <PROJECT> tools call story.plan_job --input '{
  "storyId": "<STORY_ID>", "kind": "actPlan", "chapterId": "<CHAPTER_ID>"
}' --json
```

Start each returned wave, wait, and let the room apply it. Then plan the board:

```bash
moka --project <PROJECT> tools call story.plan_job --input '{
  "storyId": "<STORY_ID>",
  "kind": "storyboard",
  "chapterId": "<CHAPTER_ID>",
  "model": "<TEXT_MODEL>",
  "videoModel": "<VIDEO_MODEL>"
}' --json
```

For each wave in `waves`, start one batch:

```bash
moka --project <PROJECT> --yes tools call story.start_job --input @wave.json --wait 600 --json
```

`--wait` timing out is not a failure. Poll `moka tasks get storyJob <ID> --json`
until the batch is terminal. A failed item keeps its `error` and `errorCode`; say
both, and do not replay a spending call blindly.

When the room has applied the board, read it back:

```bash
moka --project <PROJECT> tools call story.board_report --input '{
  "storyId": "<STORY_ID>", "chapterId": "<CHAPTER_ID>"
}' --json
```

**Checkpoint 1 — the board.** Show one compact table: acts, shots, planned time
against the chapter target, warnings. Ask for one of: approve, rewrite the whole
chapter, redraw acts (list ids), or stop. Do not draw a single frame before the
board is approved.

## 5. Cast pictures, then frames

Cast pictures first, so every frame can travel with the faces it needs:

```bash
moka --project <PROJECT> tools call story.plan_job --input '{
  "storyId": "<STORY_ID>", "kind": "elementArt", "chapterId": "<CHAPTER_ID>",
  "views": ["main"], "model": "<IMAGE_MODEL>"
}' --json
```

Start the waves and wait. Then draw the four-view sheets of the characters that
now have a main picture:

```bash
moka --project <PROJECT> tools call story.plan_job --input '{
  "storyId": "<STORY_ID>", "kind": "elementArt", "chapterId": "<CHAPTER_ID>",
  "views": ["turnaround"], "model": "<IMAGE_MODEL>"
}' --json
```

Then every frame still missing a picture:

```bash
moka --project <PROJECT> tools call story.plan_job --input '{
  "storyId": "<STORY_ID>", "kind": "keyframeArt", "chapterId": "<CHAPTER_ID>",
  "model": "<IMAGE_MODEL>"
}' --json
```

Start each wave, wait, and let the room apply it. `plan_job` already leaves out
frames that have a current picture and shots marked as needing none. If a frame
names someone with no picture, the planner warns; draw that element first rather
than accepting a frame with the wrong face.

Before drawing, the room may hold hand-written prompt overrides; `plan_job` now reads them, so a frame the reader edited is asked for in their words. A bridge is filmed only once both neighbours have clips: `plan_job kind:"actVideo"` reports the one it cannot film yet.

Read `story.board_report` again. **Checkpoint 2 — the frames.** Show the shots
still missing a picture, the cast still incomplete, and the total count. Ask for
one of: approve all frames, redraw the listed shots (ids), or stop. To redraw:

```bash
moka --project <PROJECT> tools call story.plan_job --input '{
  "storyId": "<STORY_ID>", "kind": "keyframeArt", "chapterId": "<CHAPTER_ID>",
  "keyframeIds": ["<SHOT_ID>", "..."], "includeExisting": true,
  "model": "<IMAGE_MODEL>"
}' --json
```

## 6. Clips, lines and score

Follow the story's own shot granularity. If `story.shotGranularity` is
`keyframe`, or an act's `shotGranularity` says `keyframe`, film that act's shots;
otherwise film the act whole. Do not mix the two for one act.

Act clips:

```bash
moka --project <PROJECT> tools call story.plan_job --input '{
  "storyId": "<STORY_ID>", "kind": "actVideo", "chapterId": "<CHAPTER_ID>",
  "model": "<VIDEO_MODEL>"
}' --json
```

Shot clips:

```bash
moka --project <PROJECT> tools call story.plan_job --input '{
  "storyId": "<STORY_ID>", "kind": "keyframeVideo", "chapterId": "<CHAPTER_ID>",
  "model": "<VIDEO_MODEL>"
}' --json
```

Either clip plan carries the speakers' own voices with it. When the chosen
video model's converter declares `audioReference`, every speaking character
who has a recording on their card travels as a `referenceAudio` input, up to
three speakers, one clip. The ask also gains the `<Audio k>` lines that tell
the service which speaker each recording voices. A converter may narrow this
to a recording window of its own — MiniMax H3 names 11 seconds — and a piece
past that window is filmed without the recordings, with the plan saying so in
`warnings`; split the act or the shot, or accept the picture-only clip. A model whose converter does
not declare the feature is planned without voice references — choose another
video model rather than writing the inputs by hand.

Lines, one ask a line, grouped by the voice each speaker has on file:

```bash
moka --project <PROJECT> tools call story.plan_job --input '{
  "storyId": "<STORY_ID>", "kind": "lineVoice", "chapterId": "<CHAPTER_ID>",
  "model": "<SPEECH_MODEL>"
}' --json
```

Score:

```bash
moka --project <PROJECT> tools call story.plan_job --input '{
  "storyId": "<STORY_ID>", "kind": "music", "chapterId": "<CHAPTER_ID>",
  "model": "<MUSIC_MODEL>"
}' --json
```

Start the waves sequentially, wait for each, and let the room apply the answers.
Then read both review sheets:

```bash
moka --project <PROJECT> tools call story.board_report --input '{"storyId":"<STORY_ID>","chapterId":"<CHAPTER_ID>"}' --json
moka --project <PROJECT> tools call story.dubbing_report --input '{"storyId":"<STORY_ID>","chapterId":"<CHAPTER_ID>"}' --json
```

**Checkpoint 3 — the clips and the voices.** Show missing clips, missing lines,
lines that run past their shot, and incomplete scores. Ask for one of: approve,
redo the listed acts/shots/lines, or stop. Redo only the listed places with
`includeExisting: true` and the matching `actId`/`keyframeIds`.

## 7. Handoff

Read the slots once more:

```bash
moka --project <PROJECT> tools call story.get --input '{
  "storyId": "<STORY_ID>", "chapterId": "<CHAPTER_ID>", "include": ["slots", "progress"]
}' --json
```

If the reader wants a cut now, `story.assemble` lays the chapter's pictures and
clips into a timeline. The CLI's assembly lays the picture; the room's Edit step
is where voice and score are laid beside it. Say which of the two was done —
never call a cut finished when its sound is not in it.

Do **not** confirm the storyboard or edit step unless the reader explicitly
says to. A finished batch is not a confirmation.

Final answer: what was made, the model ids used, job ids and final states, what
the reader approved, and anything still missing or warned about. The reader
should be able to open the story board, press play on the chapter, and see the
film the report describes.

## 8. What this skill does not do

These are places where the room still leads:

- importing a timeline into a story;
- drawing the mask itself (the mask file has to exist; `pictureEdit` uses it).

The manuscript split is now `story.split_manuscript` (paid and destructive; confirm first), the staging check and outline revision are plannable (`kind:"continuity"`
and `kind:"outlineRevision"`); an outline revision answer is still a proposal
the reader settles in its preview, never a patch this skill writes. Use
`story.focus` to ask an open room to move to a story, step and chapter; it is a
request, not a guarantee. `story.import_canvas` lays the telling's cards on a
canvas and wires them.

Everything else — the board, the cast pictures, the frames, the clips, the
lines, the score, the review sheets and the assembled cut — is covered here.

## 9. When to stop and ask

Stop and put the real reason in front of the reader when:

- the project, story or chapter is ambiguous or missing;
- idea, outline or elements is unconfirmed;
- no model is configured for a capability the run needs;
- the story room is not open, or its document stays behind after a job;
- a job failed, or its answer could not be read into the story;
- a chapter has no shots after a board run, or a shot that should be filmed has
  no picture;
- the reader has not approved the checkpoint the run is standing at.

Never work around a failed step by writing the same answer through a second
path. Never pass `--yes` for a spending or destructive call the reader did not
authorise in this conversation. Never confirm a step on the reader's behalf.
