---
name: moka-storyboard
description: Batch-produce one Moka Canvas chapter from storyboard to finished pictures, clips, voices and score, with human review at a few batch checkpoints. Use when the user asks for a storyboard, shot list, batch picture/clip/voice production, or to take a chapter to a state ready for editing.
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

Check `confirmedSteps` and `progress`. A story passes five gates, in order:
**idea → outline → elements → storyboard → edit**.

Work one gate at a time. Finish that gate's content, show it to the reader,
and ask them to confirm it in their own words. Only after they confirm, call
`story.confirm_step` for that gate, then begin the next one. Never ask for
several gate confirmations at once, never treat "start production" as a
blanket confirmation, and never confirm a step for the reader. A board is
written from the cast on file; an unconfirmed or invented cast is not a cast to
draw from.

**The cast is identified by the CLI's own reading, not by the agent.** At the
elements gate, plan `kind:"elements"` and start it; the model's answer is the
base cast. `plan_job` splits a long telling into `elements:1..n` parts by the
story's `splitChars` setting (or the `budget` you pass), and each part carries
the telling's own cast lists and recurring scene headings as a checklist. Start
the parts, wait for each, and let the room apply them. When every part is in,
call `story.element_repeats` with their batch ids, hand the returned `groups`
to `plan_job kind:"mergeElements"`, and start that merge; it reconciles a name
the parts described more than once without losing a form. Then call
`story.audit_elements`: it compares the cast with the cast lists and recurring
scene headings of the scripts and reports names and places no element covers.
After the room has applied the base cast and the merge, an agent may supplement
what the reading missed — the audit's list, plus every visually distinct form
of one — but must not hand-write the cast in place of that reading, and must
not skip it because the agent thinks it already knows the story. A whole-telling
answer stands for the cast; a part answer is added to it. Each visually
different appearance (age, outfit, damaged or intact state, day or night,
weather) is a `form` with its own complete description, never an alternative
inside one description.

The elements gate has a fixed order, and the step is confirmed only after its
pictures are approved:

1. Show the cast list and let the reader settle it in their own words.
2. Draw the **default form** of every element as candidates — three per
   character, two per scene, one per prop (section 5) — start the batches, and
   let the room apply them.
3. The reader chooses one main picture for each place in the UI and confirms
   those choices. Never choose for them.
4. Draw every **other form** of each element. Each form's picture is made from
   the default form the reader just chose: point the form's `reference` at the
   element's default form before planning (section 5).
5. The reader confirms the forms.
6. Only then call `story.confirm_step` for `elements`, and move on to the
   board.

Never confirm on the reader's behalf. The cast list is settled by the reader's
words before any art; `confirm_step` waits until the main pictures and then the
forms are approved.

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

After the reader has answered the batch question and approved the spend,
start each wave as one batch:

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

Cast pictures are drawn at the elements gate, after the reader has settled the
cast list and before the step is confirmed or the board is written. They come in
two passes, with the reader between them.

**First pass — the default forms.** Plan one ask per kind, naming that kind's
places in `elementIds`:

```bash
moka --project <PROJECT> tools call story.plan_job --input '{
  "storyId": "<STORY_ID>", "kind": "elementArt", "chapterId": "<CHAPTER_ID>",
  "views": ["main"], "model": "<IMAGE_MODEL>", "count": 3,
  "elementIds": ["<CHARACTER_ID>", "..."]
}' --json
```

Repeat for the scenes with `"count": 2` and the props with `"count": 1`. `count`
is per form and per view, and `plan_job` asks for an element's other forms too;
in this pass start only the asks whose target names no form (`target.variantId`
is absent). The room files each place's candidates as a pending set; the reader
chooses one for each place in the UI and confirms. Never choose for them, and do
not start the second pass before they confirm.

Start each element-art batch with `parallel` set to the number of models the
project selects for that place — a project fact, read from its AGENTS.md, not
repeated here. `parallel` is per model: one batch carrying the whole pool uses
the pool size, while a pool started as one batch per model uses `parallel: 1`,
which puts the same number of drawings in flight. Both `count` and `parallel`
are supported by the CLI: `start_job` carries the copies and set id, and the
room applies them as a pending set, so use them rather than asking the reader
to press the UI.

**Second pass — the other forms.** Each form's picture is drawn from the default
form the reader just chose, so first point every form's `reference` at its
element's default form. Read the element, then call `story.update_element` with
the element's complete `patch.variants` list, each form carrying the reference
it should be drawn from (an existing reference to another element is left as it
is):

```bash
moka --project <PROJECT> tools call story.update_element --input ./element-patch.json --json
```

The patch replaces `variants` whole, so send every form back, not just the one
being changed. Then plan `elementArt` with `views: ["main"]` again, the same
`count` per kind and the same `elementIds`, and start only the asks whose target
names a form (`target.variantId` present). The reader confirms these pictures,
and only then call `story.confirm_step` for `elements`.

A four-view sheet needs a chosen main picture: once the reader has chosen, draw
the four-view sheets of the characters that now have one, and only when they
want them:

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

Before drawing, the room may hold hand-written prompt overrides; `plan_job` now
reads them, so a frame the reader edited is asked for in their words. A bridge
is filmed only once both neighbours have clips: `plan_job kind:"actVideo"`
reports the one it cannot film yet.

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
video model's converter declares `audioReference`, the piece's speaking
characters who have a recording on their card travel as `referenceAudio`
inputs — as many as the converter reads, which MiniMax H3 names as three. The
ask also gains the `<Audio k>` lines that tell the service which speaker each
recording voices. A converter may narrow this to a recording window of its own
— MiniMax H3 names 11 seconds — and a piece past that window is filmed without
the recordings, with the plan saying so in `warnings`; split the act or the
shot, or accept the picture-only clip. A model whose converter does not declare
the feature is planned without voice references — choose another video model
rather than writing the inputs by hand.

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

### 6.1 Repairing lines and finished frames

A speech job that times out is not proof the service is down. Read the model
service's own log (the host and port in its model config) before changing
anything:

- A short line that takes minutes is usually a runaway sample. Check the log's
  `audio_s` and `finish`; a few-character line should not produce minutes of
  audio. Cap the request with the service's token field, scaled from the
  characters and the expected duration (the project's `AGENTS.md` records the
  exact formula for its deployment), and treat `finish=length` as a bad take
  rather than a success.
- Probe the service with one short line before spending a batch. Read the
  response headers and warning field; a 500 raised after the audio is generated,
  for example while the service writes a warning header, points to an encoding
  or version mismatch rather than to the model's ability to speak. Check the
  service log and version.
- A cloning request should carry **one** reference recording and no style text.
  If the model speaks the style instruction aloud, repeats the line, or
  rambles, drop the style fields whenever a reference is present, keep one
  reference, and re-probe (the project's `AGENTS.md` records the exact fields
  for its deployment). This is a model-integration bug, not a property of the
  line.
- Short lines need a seed and conservative sampling. Lower the audio/text
  temperature, fix the seed, trim the tail silence, and check by ASR. ASR
  homophones are not pronunciation errors; verify the take before rejecting it.
- Takes generated before a speech fix are suspect. A line slot can hold a
  minutes-long ramble for a short line, and the dubbing report will show it as
  an overrun. Regenerate the whole batch, do not patch single slots.
- Before treating a bad reading as a video defect, check whether any cut uses
  it. Act clips carry their own audio; line slots may be unused.

**Text baked into frames** is a picture repair, not a reason to re-roll the
video model. Scan full frames at about 1 fps, not just the bottom strip;
captions often sit at 70–80% height. For a locked-off shot, take a clean plate
from a frame in the same shot where the text is absent and overlay only the
text's rectangle; for text over a moving but textured area, use a tight
`delogo` box. Keep the original audio. If neither can be done without touching
faces, report it and ask for a new shot rather than burning renders on the same
prompt.

## 7. Handoff

Read the slots once more:

```bash
moka --project <PROJECT> tools call story.get --input '{
  "storyId": "<STORY_ID>", "chapterId": "<CHAPTER_ID>", "include": ["slots", "progress"]
}' --json
```

If the reader wants a cut now, `story.assemble` lays the chapter's pictures,
clips, line readings, whole-act voice and score into a timeline of that
chapter's own, with optional subtitles; pass `chapterId`. Each episode keeps its
own assembled timeline, so check with the reader before overwriting that
episode's existing cut; the room's Edit step is where the cut is reviewed and
adjusted. Say what was assembled — never call a cut finished when its sound is
not in it.

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

If a step you need has no tool behind it, check the catalog first
(`moka tools list --json`, `moka tools describe <name>`). If the tool is absent
or does not do what the workflow needs, stop and tell the reader what is missing
and which call you tried. Do not invent a tool, patch the running server, or
change an installed binary; the project's `AGENTS.md` records deployment-specific
rules, and the reader decides how to proceed.

## 9. When to stop and ask

Stop and put the real reason in front of the reader when:

- the project, story or chapter is ambiguous or missing;
- idea, outline or elements is unconfirmed;
- no model is configured for a capability the run needs;
- the server refuses a call for authentication;
- the workflow needs a tool this build does not have (check the catalog to
  confirm, then report it — do not patch the tool yourself);
- the story room is not open, or its document stays behind after a job;
- a job failed, or its answer could not be read into the story;
- a chapter has no shots after a board run, or a shot that should be filmed has
  no picture;
- the reader has not approved the checkpoint the run is standing at.

Never work around a failed step by writing the same answer through a second
path. Never pass `--yes` for a spending or destructive call the reader did not
authorise in this conversation. Never confirm a step on the reader's behalf.
