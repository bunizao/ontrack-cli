import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { checkIntentCommands, commandsJson, writeAgentFiles } from "@bunizao/cli-kit";

import { executeCli, nounSpecs, type CliApplication } from "../src/cli-app.js";
import { INTENTS, skillFiles } from "../src/skill.js";

// Compiled tests live in .build/tests, so the repository root is two levels up.
const root = fileURLToPath(new URL("../../", import.meta.url));
const version = (JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { version: string }).version;

async function builtProgram(): Promise<Parameters<typeof checkIntentCommands>[0]> {
  let program: Parameters<typeof checkIntentCommands>[0] | undefined;
  const result = await executeCli(["--help"], {
    application: async () => ({}) as CliApplication,
    version,
    onProgram: (built) => { program = built; },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(program, "executeCli must build a program");
  return program;
}

export async function test_every_intent_command_parses_against_the_command_tree(): Promise<void> {
  checkIntentCommands(await builtProgram(), nounSpecs, INTENTS);
}

export async function test_courses_is_the_canonical_noun_with_units_and_projects_as_aliases(): Promise<void> {
  const tree = commandsJson(await builtProgram());
  const courses = tree.commands.find((command) => command.name === "courses");
  assert.ok(courses, "courses must be a top-level command");
  assert.deepEqual(courses.aliases, ["units", "projects"]);
  assert.equal(tree.commands.some((command) => command.name === "units"), false);
}

export async function test_committed_agent_files_match_the_command_tree(): Promise<void> {
  const files = skillFiles(commandsJson(await builtProgram()), version);
  assert.deepEqual(
    writeAgentFiles(root, files, { check: true }),
    [],
    "agent files are stale; run `npm run skill:generate` and commit the result",
  );
}
