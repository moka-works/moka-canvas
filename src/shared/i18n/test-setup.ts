import { configure } from "@testing-library/react";
import { afterEach } from "vitest";
import { forgetTextAssets } from "../../features/story/readText";
import { i18n } from ".";

// The interface starts in the machine's language and the suite asserts
// English words, so the language is pinned before any test renders.
void i18n.changeLanguage("en");

// A manuscript read in one test is not the manuscript the next one writes:
// the session cache is cleared between tests so a stub that answers with new
// words is the one the next assertion sees.
afterEach(() => {
  forgetTextAssets();
});

// The suite runs its files in parallel, and a room test boots the whole app
// in jsdom with the workers beside it competing for the machine, so a ready
// interface can take well past the default second to appear. The waits are
// about what the interface settles on, not how quickly it is handed over.
configure({ asyncUtilTimeout: 3000 });
