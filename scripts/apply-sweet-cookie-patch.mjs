import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageEntry = fileURLToPath(import.meta.resolve("@steipete/sweet-cookie"));
const target = join(dirname(packageEntry), "providers/chromeSqlite/shared.js");
const original = "const rows = db.prepare(options.sql).all();";
const replacement = `const statement = db.prepare(options.sql);
            if (typeof statement.setReadBigInts === "function") {
                statement.setReadBigInts(true);
            }
            const rows = statement.all();`;
const source = readFileSync(target, "utf8");

if (source.includes(replacement)) process.exit(0);
if (!source.includes(original)) {
  throw new Error("Unsupported @steipete/sweet-cookie source; update the compatibility patch.");
}
writeFileSync(target, source.replace(original, replacement), "utf8");
