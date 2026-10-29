import { agentFiles, type Intent, type ProgramDescription } from "@bunizao/cli-kit";

// What a person says, mapped to the one command that answers it.
// UNIT and TASK are placeholders; the site's own lists are the vocabulary.
export const INTENTS: readonly Intent[] = [
  {
    when: "which units am I in / how are units named here",
    what: "Your enrolled units with project ID, code, name and target grade.",
    command: "ontrack courses",
    then: "`--include-inactive` for past units",
  },
  {
    when: "what's in UNIT / my target grade / overall progress",
    what: "One unit with your target grade and overall progress.",
    command: "ontrack courses show UNIT",
  },
  {
    when: "which tasks / what's due / what needs work",
    what: "Every task in the unit with its status and due date.",
    command: "ontrack tasks UNIT",
    then: "`--status <status...>` to narrow",
  },
  {
    when: "what does task X say / the task sheet",
    what: "The task sheet as Markdown.",
    command: "ontrack tasks read UNIT TASK",
    then: "`tasks show` for status only",
  },
  {
    when: "download the task sheet / task resources",
    what: "The task sheet, or with `--resources` its linked files, saved to disk.",
    command: "ontrack tasks get UNIT TASK [--resources] --dest PATH",
    then: "`ontrack courses get UNIT` for the whole unit",
  },
  {
    when: "any tutor feedback / unread messages",
    what: "Unread chat comments per task.",
    command: "ontrack chats UNIT",
  },
  {
    when: "read the tutor's comments on a task",
    what: "The task's chat history. It also marks the comments read upstream.",
    command: "ontrack chats read UNIT TASK --yes",
    then: "tell the user before running it",
  },
  {
    when: "mark a task ready / working on it / need help",
    what: "Sets the task's workflow state.",
    command: "ontrack tasks set UNIT TASK STATE",
  },
  {
    when: "submit files for a task",
    what: "Uploads the files as the task's submission.",
    command: "ontrack tasks submit UNIT TASK --file F",
  },
  {
    when: "message the tutor on a task",
    what: "Sends one chat message on the task.",
    command: "ontrack chats send UNIT TASK --message \"...\"",
  },
  {
    when: "am I signed in / is it working",
    what: "Whether the saved session still works.",
    command: "ontrack auth status",
    then: "`ontrack auth login` to sign in",
  },
  {
    when: "my teaching roles",
    what: "The teaching roles you hold.",
    command: "ontrack roles",
    then: "`--all` includes inactive roles",
  },
];

const DESCRIPTION =
  "Reads OnTrack and Doubtfire units, tasks, task sheets and tutor chats from the terminal; sets task status, submits files and messages tutors when asked";

// Moodle and Ed Discussion skills sit next to this one, so name the overlap and send it there.
const USE_WHEN =
  'the user names OnTrack or Doubtfire, or asks about portfolio tasks, task sheets, task status, a target grade or tutor feedback on a task: "which tasks are overdue", "what does 3.1P ask for", "did my tutor reply", "mark 2.1P ready for feedback", "submit my pass task". Moodle assignments, quizzes and the gradebook belong to moodle-cli; Ed forum threads and lessons belong to edstem-cli';

/** Every generated agent file, keyed by path from the repository root. */
export function skillFiles(program: ProgramDescription, version: string): Record<string, string> {
  return agentFiles({
    skill: {
      name: "ontrack-cli",
      description: DESCRIPTION,
      useWhen: USE_WHEN,
      title: "OnTrack CLI",
      intro: [
        "Use `ontrack` to inspect and update OnTrack from a terminal. Start from what the user said, not from ids.",
        "`UNIT` is a project ID, or the unit's code or name exactly as OnTrack shows it; `ontrack courses` is the vocabulary for this site. `TASK` is the task abbreviation shown by `ontrack tasks UNIT`, or a task definition ID. Never assume what a code or abbreviation looks like; if a reference matches several units the CLI lists their project IDs, so pick one rather than guess.",
      ].join("\n\n"),
      intents: INTENTS,
      rules: [
        "`courses`, `units` and `projects` are interchangeable.",
        "`chats read` is the exception to the `read` rule: it marks the comments read upstream, so `ontrack chats` stops flagging them; it needs `--yes`.",
        "Sign in with `ontrack auth login`; `ontrack auth status` checks the saved session and `ontrack auth logout` removes it.",
      ],
      setup: [
        "```bash",
        "npm install -g ontrack",
        "export ONTRACK_BASE_URL=\"https://ontrack.example.edu\"  # your institution's OnTrack site",
        "ontrack auth login",
        "```",
      ].join("\n"),
      program,
    },
    version,
    repository: "https://github.com/bunizao/ontrack-cli",
    author: { name: "bunizao", url: "https://github.com/bunizao" },
    license: "MIT",
    keywords: ["ontrack", "doubtfire", "university", "tasks", "cli"],
    openai: {
      displayName: "OnTrack CLI",
      shortDescription: "Check OnTrack tasks, read task sheets, follow tutor chats and submit work",
      defaultPrompt: "Use $ontrack-cli to check my OnTrack tasks, read a task sheet or tutor feedback, or submit a task with the narrowest relevant command.",
    },
  });
}
