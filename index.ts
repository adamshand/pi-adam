import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEnvFeature } from "./features/env.ts";
import { registerFooterFeature } from "./features/footer.ts";
import { registerHerdrTodosFeature } from "./features/herdr-todos.ts";
import { registerMruFeature } from "./features/mru.ts";

export default function piAdam(pi: ExtensionAPI): void {
	registerEnvFeature(pi);
	registerFooterFeature(pi);
	registerHerdrTodosFeature(pi);
	registerMruFeature(pi);
}
