import { readFileSync } from "node:fs";

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };

if (typeof metadata.version !== "string") throw new TypeError("package.json version must be a string");

export const VERSION = metadata.version;
