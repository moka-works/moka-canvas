import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "./fixtures";
import {
  APP,
  configureModels,
  forgetHome,
  forgetProjects,
  openSeededStory,
  projectHome,
} from "./helpers";

test.describe.configure({ timeout: 120_000 });

/**
 * A clip carrying the speakers' own recordings.
 *
 * The recording lives on the character card, the model is one whose converter
 * declares audioReference, and the board attaches the two without the reader
 * choosing anything per shot: the act card says the recordings ride, and the
 * clip's words say which speaker each one voices. Nothing is filmed here — the
 * ask is what a reader sees before pressing send.
 */
test("a clip carries each speaking character's own recording", async ({
  page,
}) => {
  const home = projectHome("story-voice-refs");
  await forgetProjects();
  await configureModels([
    {
      id: "h3",
      capability: "video",
      alias: "H3",
      converter: "minimaxVideo",
    },
  ]);
  let speaker = "";
  try {
    await openSeededStory(page, home, true, async () => {
      // A recording of the project's own, filed the way the shelf files one.
      const bytes = readFileSync(
        fileURLToPath(new URL("./fixtures/voice.wav", import.meta.url)),
      );
      const form = new FormData();
      form.set("categoryHint", "voice");
      form.set("file", new Blob([bytes], { type: "audio/wav" }), "voice.wav");
      const uploaded = await fetch(`${APP}/api/v1/projects/current/assets`, {
        method: "POST",
        body: form,
      });
      expect(uploaded.ok).toBe(true);
      const filed = (await uploaded.json()) as { entry: { id: string } };

      // The character who speaks the first line wears the recording.
      const document = (await (
        await fetch(`${APP}/api/v1/projects/current`)
      ).json()) as {
        moka: {
          stories: Array<{
            id: string;
            name: string;
            elements: Array<{ id: string; kind: string; name: string }>;
            chapters: Array<{
              acts: Array<{
                keyframes: Array<{
                  dialogue: Array<{
                    characterId?: string;
                    speaker: string;
                    text: string;
                  }>;
                }>;
              }>;
            }>;
          }>;
        };
      };
      const story = document.moka.stories.find(
        (held) => held.name === "Rain at Night",
      )!;
      const line = story.chapters[0]!.acts[0]!.keyframes.flatMap(
        (keyframe) => keyframe.dialogue,
      ).find((held) => held.text.trim() !== "")!;
      const character = story.elements.find(
        (element) =>
          element.id === line.characterId ||
          (element.kind === "character" &&
            element.name === line.speaker.trim()),
      )!;
      speaker = character.name;
      const setVoice = await fetch(
        `${APP}/api/v1/agent/tools/story.update_element`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actor: "ui",
            acknowledgeRisk: true,
            input: {
              storyId: story.id,
              elementId: character.id,
              patch: {
                voice: {
                  model: "",
                  voice: "",
                  referenceAssetId: filed.entry.id,
                },
              },
            },
          }),
        },
      );
      expect(setVoice.ok).toBe(true);
    });

    // Step four: the act card says the recording rides with its clip, and the
    // words that stand in front of the press carry the mapping.
    await page.getByTestId("story-step-storyboard").click();
    await expect(page.getByTestId("story-step-body-storyboard")).toBeVisible();
    const firstAct = page.getByTestId("story-act-0");
    await expect(firstAct.getByTestId("story-table")).toBeVisible({
      timeout: 30_000,
    });
    // The model menu names the recording window and count the converter
    // declares, so the choice is made on what the model can do.
    await page.getByTestId("story-model-video-toggle").click();
    await expect(
      page.getByTestId("story-model-video-option-h3"),
    ).toHaveAccessibleName("H3 Voice refs ≤11s · 3 speakers");
    await page.getByTestId("story-model-video-toggle").click();
    await expect(firstAct.getByTestId("story-act-voice-refs-0")).toContainText(
      speaker,
    );

    await firstAct.getByTestId("story-act-video-go-0").click();
    const dialog = page.getByTestId("story-video-prompt-dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByTestId("story-video-prompt-voice-refs"),
    ).toContainText(speaker);
    const words = dialog.getByTestId("story-video-prompt-text-0");
    await expect(words).toHaveValue(/Voice references:/);
    await expect(words).toHaveValue(/\(S\d+\)/);
    await expect(words).toHaveValue(/<Audio 1>/);
  } finally {
    forgetHome(home);
  }
});
