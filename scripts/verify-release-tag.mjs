import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(readFileSync("package.json", "utf8"));
const actualTag = process.env.GITHUB_REF_NAME;
const expectedTag = `v${packageMetadata.version}`;

if (actualTag !== expectedTag) {
  throw new Error(`Release tag ${actualTag ?? "<missing>"} does not match package version ${expectedTag}`);
}

process.stdout.write(`Validated ${actualTag} for ${packageMetadata.name}\n`);
