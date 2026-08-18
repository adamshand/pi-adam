import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentBrowserFeature } from "./features/agent-browser.ts";
import { registerCodexImageFeature } from "./features/codex-image.ts";
import { registerEnvFeature } from "./features/env.ts";
import { registerFooterFeature } from "./features/footer.ts";
import { registerHerdrGitMetadataFeature } from "./features/herdr-git-metadata.ts";
import { registerHerdrSessionNameFeature } from "./features/herdr-session-name.ts";
import { registerHerdrTodosFeature } from "./features/herdr-todos.ts";
import { registerMruFeature } from "./features/mru.ts";
import { registerTodosFeature } from "./features/todos.ts";
import { registerTurnStampFeature } from "./features/turn-stamp.ts";

export default function piAdam(pi: ExtensionAPI): void {
	registerAgentBrowserFeature(pi);
	registerCodexImageFeature(pi);
	registerEnvFeature(pi);
	registerFooterFeature(pi);
	registerHerdrGitMetadataFeature(pi);
	registerHerdrSessionNameFeature(pi);
	registerTodosFeature(pi);
	registerHerdrTodosFeature(pi);
	registerMruFeature(pi);
	registerTurnStampFeature(pi);
}
