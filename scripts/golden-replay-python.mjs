import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import process from "node:process";

const usage = "Usage: node scripts/golden-replay-python.mjs --python <absolute-path> --python-checkout <git-checkout> --tool-checkout <clean-ontrack-cli-checkout> --entrypoint <module> --fixture <http.json> --session <session.json> --env <env.json> --stdout <path> --stderr <path> --exit <path> --provenance <path> -- <argv...>\n";
const requiredOptions = [
  "python", "python-checkout", "entrypoint", "fixture", "session", "env",
  "stdout", "stderr", "exit", "provenance", "tool-checkout",
];
const allowedEnvironment = new Set(["COLUMNS", "NO_COLOR", "ONTRACK_NOW", "TERM"]);
const liveHostname = "ontrack.infotech.monash.edu";
const credentialValue = /(?:\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|\b[A-Za-z0-9_-]{48,}\b)/iu;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1) throw new Error("the command argv must follow --");
  const optionArguments = argv.slice(0, separator);
  const commandArgv = argv.slice(separator + 1);
  const options = {};
  for (let index = 0; index < optionArguments.length; index += 2) {
    const name = optionArguments[index];
    const value = optionArguments[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error("runner options must use --name value pairs");
    const key = name.slice(2);
    if (!requiredOptions.includes(key)) throw new Error(`unknown runner option --${key}`);
    if (options[key] !== undefined) throw new Error(`duplicate runner option --${key}`);
    options[key] = value;
  }
  for (const key of requiredOptions) {
    if (!options[key]) throw new Error(`missing required runner option --${key}`);
  }
  if (commandArgv.length === 0) throw new Error("the Python command argv must not be empty");
  return { options, commandArgv };
}

function assertSafeString(value, label) {
  const lowered = value.toLowerCase();
  if (lowered.includes(liveHostname) || credentialValue.test(value)) {
    throw new Error(`${label} contains a credential-shaped value or live hostname`);
  }
}

async function readJson(path, label) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} must be readable JSON`);
  }
  return value;
}

function validateSession(value) {
  const keys = value === null || typeof value !== "object" || Array.isArray(value)
    ? []
    : Object.keys(value).sort();
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !([2, 3].includes(keys.length))
    || !keys.includes("base_url") || !keys.includes("username")
    || keys.some((key) => !["base_url", "user", "username"].includes(key))) {
    throw new Error("session must contain base_url, username, and optional sanitized user");
  }
  if (typeof value.base_url !== "string" || typeof value.username !== "string") {
    throw new Error("session base_url and username must be strings");
  }
  const url = new URL(value.base_url);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".example.invalid")
    || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("session base_url must be a sanitized https://*.example.invalid site root");
  }
  if (!new Set(["recorded-user", "synthetic-student"]).has(value.username)) {
    throw new Error("session username must be a recognized sanitized identity");
  }
  if (value.user !== undefined) {
    const userKeys = value.user === null || typeof value.user !== "object" || Array.isArray(value.user)
      ? []
      : Object.keys(value.user).sort();
    const expectedUserKeys = ["email", "first_name", "id", "last_name", "nickname", "username"];
    if (JSON.stringify(userKeys) !== JSON.stringify(expectedUserKeys)
      || value.user.username !== value.username
      || !Number.isInteger(value.user.id)
      || ["first_name", "last_name", "nickname"].some((key) => value.user[key] !== null && typeof value.user[key] !== "string")
      || typeof value.user.email !== "string" || !value.user.email.endsWith("@example.invalid")) {
      throw new Error("session user must be a complete sanitized identity");
    }
  }
  return value;
}

function validateEnvironment(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("env must be a JSON object");
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowedEnvironment.has(key)) throw new Error(`env contains unallowlisted key ${key}`);
    if (typeof item !== "string") throw new Error(`env value ${key} must be a string`);
    assertSafeString(item, `env value ${key}`);
    result[key] = item;
  }
  return result;
}

function gitCommit(checkout) {
  const result = spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  const commit = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("python-checkout must be a Git checkout with a resolvable HEAD commit");
  }
  return commit;
}

function assertCleanCheckout(checkout) {
  const result = spawnSync("git", ["-C", checkout, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  if (result.status !== 0 || result.stdout !== "") {
    throw new Error("python-checkout must be a clean Git checkout");
  }
}

async function main() {
  const { options, commandArgv } = parseArguments(process.argv.slice(2));
  if (!isAbsolute(options.python)) throw new Error("--python must be an absolute executable path");
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/u.test(options.entrypoint)) {
    throw new Error("--entrypoint must be a Python module name");
  }
  for (const [index, value] of commandArgv.entries()) assertSafeString(value, `argv[${index}]`);

  const python = resolve(options.python);
  await access(python);
  const checkout = await realpath(options["python-checkout"]);
  const toolCheckout = await realpath(options["tool-checkout"]);
  const fixturePath = resolve(options.fixture);
  const sessionPath = resolve(options.session);
  const fixtureBytes = await readFile(fixturePath);
  const sessionBytes = await readFile(sessionPath);
  const harnessPath = join(toolCheckout, "scripts", "python-replay-sitecustomize.py");
  const harnessBytes = await readFile(harnessPath);
  const session = validateSession(JSON.parse(sessionBytes.toString("utf8")));
  const environment = validateEnvironment(await readJson(options.env, "env"));
  const pythonCommit = gitCommit(checkout);
  assertCleanCheckout(checkout);
  const replayToolCommit = gitCommit(toolCheckout);
  assertCleanCheckout(toolCheckout);
  const committedHarness = spawnSync("git", ["-C", toolCheckout, "show", "HEAD:scripts/python-replay-sitecustomize.py"], {
    encoding: "buffer",
    env: { PATH: process.env.PATH ?? "" },
  });
  if (committedHarness.status !== 0 || !Buffer.from(committedHarness.stdout).equals(harnessBytes)) {
    throw new Error("replay harness must match the clean tool checkout HEAD");
  }
  const harnessDirectory = await mkdtemp(join(tmpdir(), "ontrack-python-replay-harness-"));
  const temporaryHarness = join(harnessDirectory, "sitecustomize.py");
  await writeFile(temporaryHarness, harnessBytes, { mode: 0o600 });

  const stdoutPath = resolve(options.stdout);
  const stderrPath = resolve(options.stderr);
  const exitPath = resolve(options.exit);
  const provenancePath = resolve(options.provenance);
  let stdoutFd;
  let stderrFd;
  let result;
  try {
    stdoutFd = openSync(stdoutPath, "wx", 0o600);
    stderrFd = openSync(stderrPath, "wx", 0o600);
    result = spawnSync(python, ["-m", options.entrypoint, ...commandArgv], {
      cwd: checkout,
      env: {
        ...environment,
        ONTRACK_AUTH_TOKEN: "replay-only",
        ONTRACK_BASE_URL: session.base_url,
        ...(session.user === undefined ? {} : { ONTRACK_DOUBTFIRE_USER_JSON: JSON.stringify(session.user) }),
        ONTRACK_REPLAY_FIXTURE: fixturePath,
        ONTRACK_USERNAME: session.username,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONNOUSERSITE: "1",
        PYTHONPATH: `${harnessDirectory}${delimiter}${checkout}`,
        PYTHONUTF8: "1",
      },
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
    await rm(harnessDirectory, { recursive: true, force: true });
  }

  const exitCode = result.status ?? 1;
  const rawStdoutBytes = await readFile(stdoutPath);
  const stdoutBytes = Buffer.from(
    new TextDecoder("utf-8", { fatal: true }).decode(rawStdoutBytes).replaceAll("\r\n", "\n"),
  );
  if (!stdoutBytes.equals(rawStdoutBytes)) await writeFile(stdoutPath, stdoutBytes);
  const stderrBytes = await readFile(stderrPath);
  const provenance = {
    schema: 1,
    kind: "python_fixture_replay",
    python_commit: pythonCommit,
    replay_tool_commit: replayToolCommit,
    entrypoint: options.entrypoint,
    fixture_sha256: sha256(fixtureBytes),
    session_sha256: sha256(sessionBytes),
    replay_harness_sha256: sha256(harnessBytes),
    argv: commandArgv,
    env_allowlist: Object.keys(environment).sort(),
    env: Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)),
    stdout_sha256: sha256(stdoutBytes),
    stderr_sha256: sha256(stderrBytes),
    exit: exitCode,
  };
  await Promise.all([
    writeFile(exitPath, `${exitCode}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }),
    writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }),
  ]);
  if (result.error) throw result.error;
  process.exitCode = exitCode;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(usage);
  process.exitCode = 2;
}
