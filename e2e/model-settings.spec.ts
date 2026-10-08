import { expect, test } from "@playwright/test";

import {
  CHANNEL_KEY,
  configureModels,
  configureTheWholeStudio,
} from "./helpers";
import { PROVIDER_ORIGIN, SPEAKER } from "./mock-provider";

const CHAT_URL = `${PROVIDER_ORIGIN}/v1/chat/completions`;

/**
 * Configuring a model against the real metadata store and the real stand-in.
 *
 * What a component test cannot show is that a configuration written from the
 * dialog is still there after the page is thrown away.
 */
test("a model written from the form is stored and kept", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  // The text tab is where a written-answer model belongs, and the form starts
  // from the protocol's own complete address.
  await dialog.getByRole("button", { name: "New text model" }).click();
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    "https://api.openai.com/v1/chat/completions",
  );

  // Nobody is asked for an identifier: it is derived from the display name,
  // which keeps this model's reference out of the way of the stand-in's own
  // ids the other specs already stored in the shared metadata store.
  await dialog.getByLabel("Display name").fill("Typed Model");
  await expect(dialog.getByLabel("Model identifier")).toHaveCount(0);
  await dialog.getByLabel("Endpoint URL").fill(CHAT_URL);
  await dialog.getByLabel("Model name").fill("typed-model-1");
  await dialog.getByLabel("API key").fill(CHANNEL_KEY);
  await dialog.getByRole("button", { name: "Save model" }).click();

  const named = page.locator("strong", { hasText: /^Typed Model$/ });
  const card = dialog.locator("li.model-card").filter({ has: named });
  await expect(card).toBeVisible();
  // The credential is disclosed as a masked form, and never whole.
  await expect(card.getByText(/^Key /)).toBeVisible();
  await expect(card).not.toContainText(CHANNEL_KEY);

  // The default is chosen on the card, in the category's own tab. The radio
  // is controlled by the stored view, so it becomes checked once the write
  // it caused comes back — which the assertion waits out.
  await card
    .getByRole("radio", { name: "Use Typed Model as the default text model" })
    .click();
  await expect(
    card.getByRole("radio", {
      name: "Use Typed Model as the default text model",
    }),
  ).toBeChecked();

  // A copy carries the fields and the key, and opens ready to be changed. Its
  // identifier follows the name it opens with, the way a plain new model's
  // does, and is no more visible than one.
  await card.getByRole("button", { name: "Copy Typed Model" }).click();
  await expect(dialog.getByLabel("Display name")).toHaveValue(
    "Typed Model (copy)",
  );
  await expect(dialog.getByLabel("Model identifier")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(dialog).toBeHidden();

  // What was written survives the page being thrown away.
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  // The copy from earlier is stored too, so the card is found by its exact
  // name rather than by a substring both cards carry.
  const kept = dialog.locator("li.model-card").filter({ has: named });
  await expect(kept).toBeVisible();
  await expect(
    kept.getByRole("radio", {
      name: "Use Typed Model as the default text model",
    }),
  ).toBeChecked();
});

/**
 * A video model's scenarios, configured as groups and kept that way.
 *
 * What a component test cannot show is that the groups travel through the
 * real metadata document whole: the scenarios the first group answers, and the
 * group that answers the rest, written from the form and read back after the
 * page is thrown away.
 */
test("a video model's scenario groups are stored and kept", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  await dialog.getByRole("tab", { name: "Video" }).click();
  await dialog.getByRole("button", { name: "New video model" }).click();
  await dialog.getByLabel("Display name").fill("Grouper");
  await dialog.getByLabel("Model name").fill("grouper-t2v");
  await dialog.getByLabel("Endpoint URL").fill(`${PROVIDER_ORIGIN}/v1/videos`);

  // The first group answers every scenario of the category, and with none
  // left over the form offers no group to add.
  await expect(
    dialog.getByTestId("model-group-0-scene-referenceToVideo"),
  ).toBeChecked();
  await expect(dialog.getByTestId("model-group-add")).toHaveCount(0);

  // Two scenarios freed in the first group are what a second group is for,
  // and a scenario is answered by one group: checking it in one takes it
  // from the other.
  await dialog.getByTestId("model-group-0-scene-imageToVideo").uncheck();
  await dialog.getByTestId("model-group-0-scene-firstLastFrame").uncheck();
  await dialog.getByTestId("model-group-add").click();
  await dialog.getByTestId("model-group-1-model").fill("grouper-i2v");
  await dialog.getByTestId("model-group-1-scene-imageToVideo").check();
  await dialog.getByTestId("model-group-1-scene-firstLastFrame").check();
  await expect(dialog.getByTestId("model-group-add")).toHaveCount(0);
  await dialog.getByTestId("model-group-1-scene-textToVideo").check();
  await expect(
    dialog.getByTestId("model-group-0-scene-textToVideo"),
  ).not.toBeChecked();
  await dialog.getByTestId("model-group-0-scene-textToVideo").check();
  await expect(
    dialog.getByTestId("model-group-1-scene-textToVideo"),
  ).not.toBeChecked();

  await dialog.getByRole("button", { name: "Save model" }).click();
  await expect(
    dialog.locator("strong", { hasText: /^Grouper$/ }),
  ).toBeVisible();

  // What was written survives the page being thrown away.
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await dialog.getByRole("tab", { name: "Video" }).click();
  const kept = page.locator("li.model-card").filter({
    has: page.locator("strong", { hasText: /^Grouper$/ }),
  });
  await kept.getByRole("button", { name: "Edit" }).click();
  await expect(dialog.getByLabel("Model name 2")).toHaveValue("grouper-i2v");
  await expect(
    dialog.getByTestId("model-group-1-scene-imageToVideo"),
  ).toBeChecked();
  await expect(
    dialog.getByTestId("model-group-0-scene-imageToVideo"),
  ).not.toBeChecked();
  await expect(
    dialog.getByTestId("model-group-0-scene-referenceToVideo"),
  ).toBeChecked();
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

/**
 * The window keeps its place while its tabs are turned over.
 *
 * A dialog that grows to whatever the tab holds moves under the pointer with
 * every click, so the room a tab is read in is the dialog's own and never the
 * tab's: what a tab holds too much of scrolls inside its panel, and what it
 * holds too little of leaves the bottom of that panel blank.
 */
test("the settings dialog keeps one box across its tabs", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  const boxOf = async () => {
    const box = await dialog.boundingBox();
    return [box!.x, box!.y, box!.width, box!.height].map(Math.round);
  };

  await dialog.getByRole("tab", { name: "System" }).click();
  const held = await boxOf();

  // Every face of both sections, the short ones and the one long enough to
  // need a scroll of its own.
  for (const [top, sub] of [
    ["Model", "Text"],
    ["Model", "Image"],
    ["Model", "Video"],
    ["Model", "Preferences"],
    ["System", null],
  ] as [string, string | null][]) {
    await dialog.getByRole("tab", { name: top }).click();
    if (sub) await dialog.getByRole("tab", { name: sub }).click();
    expect(await boxOf(), `${top}/${sub}`).toEqual(held);
  }

  // The preferences are longer than the panel, and are read by scrolling the
  // panel rather than by the dialog giving way to them.
  await dialog.getByRole("tab", { name: "Model" }).click();
  await dialog.getByRole("tab", { name: "Preferences" }).click();
  const overflow = await dialog
    .locator(".settings-body")
    .first()
    // The suite is compiled without the DOM's own types, so the measurements
    // are read off a shape rather than off an element.
    .evaluate((body) => {
      const sized = body as unknown as {
        scrollHeight: number;
        clientHeight: number;
      };
      return sized.scrollHeight > sized.clientHeight;
    });
  expect(overflow).toBe(true);
});

/**
 * The story room's own boundaries are stored with the rest of the preferences.
 *
 * How much of a telling one ask may carry is the reader's to set, since it is
 * the model answering that decides it, and it has to outlive the page: the room
 * reads it whenever it plans a batch. The values are put back afterwards, since
 * the suite shares one metadata store.
 */
test("the story room's boundaries are kept", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const openPreferences = async () => {
    await dialog.getByRole("tab", { name: "Preferences" }).click();
  };

  await openPreferences();
  await dialog.getByLabel("Manuscript part length").fill("9000");
  await dialog.getByLabel("Characters per reading").fill("4000");
  await dialog.getByRole("button", { name: "Save preferences" }).click();

  // What was written survives the page being thrown away.
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await openPreferences();
  await expect(dialog.getByLabel("Manuscript part length")).toHaveValue("9000");
  await expect(dialog.getByLabel("Characters per reading")).toHaveValue("4000");

  await dialog.getByLabel("Manuscript part length").fill("12000");
  await dialog.getByLabel("Characters per reading").fill("8000");
  await dialog.getByRole("button", { name: "Save preferences" }).click();
});

test("a category offers only the protocols that serve it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  await dialog.getByRole("tab", { name: "Video" }).click();

  await dialog.getByRole("button", { name: "New video model" }).click();
  const protocol = dialog.getByLabel("Protocol");
  await expect(protocol).toHaveValue("openaiVideos");
  // A chat endpoint cannot serve a video model, so it is not on offer; the
  // shapes deployed under the video capability are, in the order their own
  // documents ask for.
  await expect(protocol.locator("option")).toHaveText([
    "OpenAI-compatible · Videos API",
    "Google Gemini · long-running (Veo)",
    "Alibaba Cloud · Bailian Video",
    "Volcengine · Ark Video (Seedance)",
    "MiniMax · Video Generation (Hailuo)",
  ]);
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    "https://api.openai.com/v1/videos",
  );
});

test("each sound capability offers the shapes deployed under it", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  // A voice is asked of the speech converters this build deploys, and of no
  // other: the composer's shape is not on offer here. The suite's own clone
  // fixture is deployed under this capability too — it is a directory in the
  // throwaway models tree like any other — and is dropped here: what is
  // asserted is the list this build ships.
  await dialog.getByRole("tab", { name: "Speech", exact: true }).click();
  await dialog.getByRole("button", { name: "New speech model" }).click();
  const protocol = dialog.getByLabel("Protocol");
  await expect(protocol).toHaveValue("openaiSpeech");
  await expect(
    protocol.locator("option").filter({ hasNotText: /^E2E · / }),
  ).toHaveText([
    "OpenAI-compatible · Speech API",
    "Alibaba Cloud · Bailian Speech (CosyVoice TTS)",
    "Alibaba Cloud · Bailian Speech (CosyVoice, voice clone)",
    "MiniMax · Speech (T2A)",
  ]);
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    "https://api.openai.com/v1/audio/speech",
  );

  // A score is asked of a music model, which is a list of its own.
  await dialog.getByRole("tab", { name: "Music" }).click();
  await dialog.getByRole("button", { name: "New music model" }).click();
  await expect(protocol).toHaveValue("bailianMusic");
  await expect(protocol.locator("option")).toHaveText([
    "Alibaba Cloud · Music Generation (fun-music)",
    "MiniMax · Music Generation",
  ]);
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    "https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/music/generation",
  );
});

test("a score is kept beside the voice rather than inside it", async ({
  page,
}) => {
  await configureTheWholeStudio();
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  const cardFor = (name: string) =>
    dialog.locator("li.model-card").filter({
      has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }),
    });

  // What reads the lines is a speech model, and it is that capability's own
  // default rather than an audio tab's first entry.
  await dialog.getByRole("tab", { name: "Speech", exact: true }).click();
  await expect(cardFor("Speaker")).toBeVisible();
  await expect(
    cardFor("Speaker").getByRole("radio", {
      name: "Use Speaker as the default speech model",
    }),
  ).toBeChecked();

  // What composes is a music model on a list of its own, and the speaker is
  // not on it: a score can no longer be asked of whatever reads the lines.
  await dialog.getByRole("tab", { name: "Music" }).click();
  await expect(cardFor("Musician")).toBeVisible();
  await expect(cardFor("Speaker")).toHaveCount(0);
  await expect(
    cardFor("Musician").getByRole("radio", {
      name: "Use Musician as the default music model",
    }),
  ).toBeChecked();
});

test("every shape a category offers comes from its converter's model.json", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  await dialog.getByRole("tab", { name: "Image" }).click();
  await dialog.getByRole("button", { name: "New image model" }).click();

  const protocol = dialog.getByLabel("Protocol");
  // Both image shapes are converter directories deployed on this machine, so
  // the form names and addresses them from what each one's model.json says —
  // this program holds no table of protocols of its own.
  await expect(protocol.locator("option")).toHaveText([
    "OpenAI-compatible · Images API",
    "Alibaba Cloud · Bailian Image (Wan)",
    "Volcengine · Ark Image (Seedream)",
    "MiniMax · Image Generation",
  ]);
  await protocol.selectOption("bailianImage");
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  );

  // The text shape keeps its own address: the multimodal one is derived from
  // it at the moment a question carries a picture.
  await dialog.getByRole("tab", { name: "Text" }).click();
  await dialog.getByRole("button", { name: "New text model" }).click();
  await protocol.selectOption("bailianText");
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
  );
});

test("speech recognition offers the script that serves it", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  await dialog.getByRole("tab", { name: "Speech recognition" }).click();

  await dialog
    .getByRole("button", { name: "New speech recognition model" })
    .click();
  const protocol = dialog.getByLabel("Protocol");
  // The deployed converter is the whole of what the category offers: a
  // recognition shape is a script and a document, and nothing else.
  await expect(protocol).toHaveValue("bailianAsr");
  await expect(protocol.locator("option")).toHaveText([
    "Alibaba Cloud · Bailian Speech Recognition (recording file)",
    "MiniMax · Speech Recognition",
  ]);
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    "https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/asr/transcription",
  );
});

/**
 * What a model needs from the preferences is said where the model is chosen.
 *
 * The speech converters deployed by this build declare that they are asked for
 * a voice, so with none set the speech tab names the gap beside the default
 * rather than waiting for a read-aloud ask to come back refused.
 */
test("a speech model with no voice set is said out loud", async ({ page }) => {
  await configureModels([
    { id: SPEAKER, capability: "speech", alias: "Speaker" },
  ]);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  // The suite shares one metadata store, so what the voice was is kept to be
  // put back: the other specs are not left reading a choice made here.
  await dialog.getByRole("tab", { name: "Preferences" }).click();
  // Exact, because the field beside it is "Voice instructions".
  const voice = dialog.getByRole("textbox", { name: "Voice", exact: true });
  const save = dialog.getByRole("button", { name: "Save preferences" });
  // Only a change enables the save, so an already-empty voice is left alone.
  const was = await voice.inputValue();
  if (was !== "") {
    await voice.fill("");
    await save.click();
    await expect(save).toBeDisabled();
  }

  await dialog.getByRole("tab", { name: "Speech", exact: true }).click();
  await expect(dialog.getByTestId("speech-voice-gap")).toBeVisible();

  await dialog.getByRole("tab", { name: "Preferences" }).click();
  await voice.fill("alloy");
  await save.click();
  await expect(save).toBeDisabled();

  await dialog.getByRole("tab", { name: "Speech", exact: true }).click();
  await expect(dialog.getByTestId("speech-voice-gap")).toHaveCount(0);

  // Put the voice back as it was, unless it was the "alloy" this test set for
  // itself: the specs after this one are owed the voice a configured speech
  // model is given, so that same value is left standing rather than re-saved.
  await dialog.getByRole("tab", { name: "Preferences" }).click();
  if (was !== "alloy") {
    await voice.fill(was);
    await save.click();
  }
  await expect(save).toBeDisabled();
});
