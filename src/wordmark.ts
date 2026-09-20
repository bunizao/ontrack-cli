import type { Ui } from "@bunizao/cli-kit";

export const ONTRACK_TAGLINE = "Work with OnTrack tasks and chats from the command line.";

// figlet "Small"; kept as lines so the backslashes and the backtick survive as typed.
export const ONTRACK_WORDMARK = [
  "          _               _",
  "  ___ _ _| |_ _ _ __ _ __| |__",
  " / _ \\ ' \\  _| '_/ _` / _| / /",
  " \\___/_||_\\__|_| \\__,_\\__|_\\_\\",
].join("\n");

let shown = false;

/** The wordmark opens the first guided step of a run and no other, however many steps follow. */
export function showWordmark(ui: Ui): void {
  if (shown) return;
  shown = true;
  ui.banner(ONTRACK_WORDMARK, ONTRACK_TAGLINE);
}
