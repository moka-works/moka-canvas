import { expect, test, type Page } from "./fixtures";

import {
  APP,
  CHANNEL_KEY,
  configureModels,
  configureTheWholeStudio,
} from "./helpers";
import { PROVIDER_ORIGIN, SPEAKER } from "./mock-provider";

const CHAT_URL = `${PROVIDER_ORIGIN}/v1/chat/completions`;

/** One protocol as the converter registry declares it. */
interface RegistryProtocol {
  id: string;
  label: string;
  urlExample: string;
  order: number;
}

/**
 * A capability's protocols, in the order the form offers them and named the
 * way this suite's English browser sees them.
 *
 * Read from the server rather than written down here: shipping a converter is
 * adding a directory, and a list in this spec would be wrong the next time one
 * arrives.
 */
async function registryProtocols(
  page: Page,
  capability: string,
): Promise<RegistryProtocol[]> {
  return page.evaluate(async (capability) => {
    const response = await fetch("/api/v1/converter/protocols");
    const body = (await response.json()) as {
      protocols: Record<
        string,
        Record<
          string,
          { displayName: string; urlExample?: string; order?: number }
        >
      >;
    };
    const group = body.protocols[capability] ?? {};
    return Object.entries(group)
      .map(([id, entry]) => ({
        id,
        label: entry.displayName,
        urlExample: entry.urlExample ?? "",
        order: entry.order ?? 1000,
      }))
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }, capability);
}

/** The protocols this build ships, without the clone this suite deploys. */
function shipped(protocols: RegistryProtocol[]): RegistryProtocol[] {
  return protocols.filter((entry) => !entry.label.startsWith("E2E · "));
}

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
 * The story room's own batch boundary is stored with the rest of the
 * preferences.
 *
 * How much of a telling one ask may carry is the reader's to set, since it is
 * the model answering that decides it, and it has to outlive the page: the room
 * reads it whenever it plans a batch, whether it is cutting a manuscript or
 * reading its chapters. The value is put back afterwards, since the suite
 * shares one metadata store.
 */
test("the story room's batch boundary is kept", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const openPreferences = async () => {
    await dialog.getByRole("tab", { name: "Preferences" }).click();
  };

  await openPreferences();
  await dialog.getByLabel("Batch size").fill("9000");
  await dialog.getByRole("button", { name: "Save preferences" }).click();

  // What was written survives the page being thrown away.
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await openPreferences();
  await expect(dialog.getByLabel("Batch size")).toHaveValue("9000");

  await dialog.getByLabel("Batch size").fill("12000");
  await dialog.getByRole("button", { name: "Save preferences" }).click();
});

test("a category offers only the protocols that serve it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });

  await dialog.getByRole("tab", { name: "Video" }).click();

  await dialog.getByRole("button", { name: "New video model" }).click();
  const protocol = dialog.getByLabel("Protocol");
  // A chat endpoint cannot serve a video model, so it is not on offer; the
  // shapes deployed under the video capability are, in the order their own
  // documents ask for.
  const video = await registryProtocols(page, "video");
  await expect(protocol).toHaveValue(video[0].id);
  await expect(protocol.locator("option")).toHaveText(
    video.map((entry) => entry.label),
  );
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    video[0].urlExample,
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
  const speech = shipped(await registryProtocols(page, "speech"));
  await expect(protocol).toHaveValue(speech[0].id);
  await expect(
    protocol.locator("option").filter({ hasNotText: /^E2E · / }),
  ).toHaveText(speech.map((entry) => entry.label));
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    speech[0].urlExample,
  );

  // A score is asked of a music model, which is a list of its own.
  await dialog.getByRole("tab", { name: "Music" }).click();
  await dialog.getByRole("button", { name: "New music model" }).click();
  const music = await registryProtocols(page, "music");
  await expect(protocol).toHaveValue(music[0].id);
  await expect(protocol.locator("option")).toHaveText(
    music.map((entry) => entry.label),
  );
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    music[0].urlExample,
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
  // Every image shape is a converter directory deployed on this machine, so
  // the form names and addresses them from what each one's model.json says —
  // this program holds no table of protocols of its own.
  const image = await registryProtocols(page, "image");
  await expect(protocol.locator("option")).toHaveText(
    image.map((entry) => entry.label),
  );
  for (const entry of image) {
    await protocol.selectOption(entry.id);
    await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
      entry.urlExample,
    );
  }

  // The text shape keeps its own address: the multimodal one is derived from
  // it at the moment a question carries a picture.
  await dialog.getByRole("tab", { name: "Text" }).click();
  await dialog.getByRole("button", { name: "New text model" }).click();
  const bailianText = (await registryProtocols(page, "text")).find(
    (entry) => entry.id === "bailianText",
  );
  expect(bailianText).toBeTruthy();
  await protocol.selectOption("bailianText");
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    bailianText!.urlExample,
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
  // The deployed converters are the whole of what the category offers: a
  // recognition shape is a script and a document, and nothing else.
  const asr = shipped(await registryProtocols(page, "asr"));
  await expect(protocol).toHaveValue(asr[0].id);
  await expect(
    protocol.locator("option").filter({ hasNotText: /^E2E · / }),
  ).toHaveText(asr.map((entry) => entry.label));
  await expect(dialog.getByLabel("Endpoint URL")).toHaveValue(
    asr[0].urlExample,
  );
});

/**
 * A category's order is the reader's, and every picker offers it.
 *
 * The drag is the arrangement; what it changes is the stored order that all
 * the pickers read, so the check is that it outlives the page.
 */
test("models are arranged by dragging and the order is kept", async ({
  page,
}) => {
  const ours = ["order-a", "order-b", "order-c"];
  const put = async (id: string, name: string) => {
    const response = await fetch(`${APP}/api/v1/models`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        category: "text",
        protocol: "openaiChat",
        url: `${PROVIDER_ORIGIN}/v1/chat/completions`,
        model: id,
        displayName: name,
        enabled: true,
        apiKey: CHANNEL_KEY,
      }),
    });
    expect(response.ok, await response.text()).toBe(true);
  };
  const remove = async (id: string) => {
    await fetch(`${APP}/api/v1/models/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  };
  const storedOrder = async () => {
    const view = (await (await fetch(`${APP}/api/v1/models`)).json()) as {
      models: { id: string; category: string }[];
    };
    return view.models
      .filter((model) => model.category === "text")
      .map((model) => model.id)
      .filter((id) => ours.includes(id));
  };

  // A clean start: the suite shares one metadata store, and models are
  // appended when they are created.
  for (const id of ours) await remove(id);
  await put("order-a", "Order A");
  await put("order-b", "Order B");
  await put("order-c", "Order C");

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const card = (name: string) =>
    dialog.locator("li.model-card").filter({
      has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }),
    });

  // Only the handle moves a card: the card itself is a form. The move is
  // spelled out because a native HTML5 drag is only begun by a pointer that
  // has actually travelled a little while pressed. The card being moved is
  // the one below, so both the handle and the spot it lands on are on screen
  // however long the category's list has grown.
  await card("Order A").scrollIntoViewIfNeeded();
  const source = await card("Order B")
    .locator(".model-card-handle")
    .boundingBox();
  const target = await card("Order A").boundingBox();
  if (!source || !target) throw new Error("the order cards are not on screen");
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    source.x + source.width / 2 + 12,
    source.y + source.height / 2 + 12,
    { steps: 4 },
  );
  await page.mouse.move(target.x + 20, target.y + target.height / 4, {
    steps: 8,
  });
  await page.mouse.up();
  await expect.poll(storedOrder).toEqual(["order-b", "order-a", "order-c"]);

  // The stored order is what the page is drawn from.
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  const names = await dialog.locator("li.model-card strong").allTextContents();
  expect(names.filter((name) => name.startsWith("Order "))).toEqual([
    "Order B",
    "Order A",
    "Order C",
  ]);

  for (const id of ours) await remove(id);
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
