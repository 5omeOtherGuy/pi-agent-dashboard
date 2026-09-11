/**
 * Text that came from a worker (tool arguments, model output, ids, labels) is printed to
 * terminals and written into tmux options. Control characters must not survive that trip:
 * an escape sequence can clear and repaint a board with forged rows, set the window title,
 * or rewrite a line with a carriage return.
 */
export function terminalSafe(text: string | undefined | null, max = 120): string {
	if (!text) return "";
	// eslint-disable-next-line no-control-regex
	const stripped = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
	return stripped.replace(/\s+/g, " ").trim().slice(0, max);
}
