import { configure } from "@testing-library/react";
import { i18n } from ".";

// The interface starts in the machine's language and the suite asserts
// English words, so the language is pinned before any test renders.
void i18n.changeLanguage("en");

// The suite runs its files in parallel, and a room test boots the whole app
// in jsdom with the workers beside it competing for the machine, so a ready
// interface can take well past the default second to appear. The waits are
// about what the interface settles on, not how quickly it is handed over.
configure({ asyncUtilTimeout: 3000 });
