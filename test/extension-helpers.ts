/** Small helpers shared by extension tests. */

export { readRecord } from "../src/registry.ts";
export { visibleWidth } from "@earendil-works/pi-tui";

import { visibleWidth } from "@earendil-works/pi-tui";

/** Display width of a rendered line, ignoring ANSI styling. */
export function visibleWidthSafe(line: string): number {
	return visibleWidth(line);
}
