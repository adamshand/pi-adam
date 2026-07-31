import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodexImageFeature } from "./features/codex-image.ts";
import { registerEnvFeature } from "./features/env.ts";
import { registerFooterFeature } from "./features/footer.ts";
import { registerHerdrSessionNameFeature } from "./features/herdr-session-name.ts";
import { registerHerdrTodosFeature } from "./features/herdr-todos.ts";
import { registerMruFeature } from "./features/mru.ts";
import { registerTodosFeature } from "./features/todos.ts";

export default function piAdam(pi: ExtensionAPI): void {
	registerCodexImageFeature(pi);
	registerEnvFeature(pi);
	registerFooterFeature(pi);
	registerHerdrSessionNameFeature(pi);
	registerTodosFeature(pi);
	registerHerdrTodosFeature(pi);
	registerMruFeature(pi);
}
