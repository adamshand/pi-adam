import type { FooterControlEndpoint, FooterControlResult } from "../../../features/herdr-app-footer-controls.ts";

export function sendFooterControl(
	endpoint: Pick<FooterControlEndpoint, "socket" | "owner" | "session">,
	action: string,
	span?: import("../../../features/time-tracking-focus.ts").FocusSpan,
): Promise<FooterControlResult>;
