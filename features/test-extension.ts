import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Build the deliberately small ExtensionAPI surface exercised by a unit test. */
export function createTestExtensionApi<Stub extends NonNullable<unknown>>(stub: Stub): ExtensionAPI {
	// SAFETY: Each test invokes only methods supplied by its local stub; missing Pi methods are never observed.
	// @ts-expect-error Deliberately incomplete test doubles cannot structurally satisfy the full Pi API.
	return stub as ExtensionAPI;
}

/** Build the deliberately small ExtensionContext surface exercised by a unit test. */
export function createTestExtensionContext<Stub extends NonNullable<unknown>>(stub: Stub): ExtensionContext {
	// SAFETY: Each test invokes only properties supplied by its local stub; missing Pi context properties are never observed.
	// @ts-expect-error Deliberately incomplete test doubles cannot structurally satisfy the full Pi context.
	return stub as ExtensionContext;
}
