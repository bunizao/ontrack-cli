import assert from "node:assert/strict";

import { CliError } from "../src/errors.js";
import { readProject, readProjects, readRoles, readTaskComments, readUnit } from "../src/readers.js";

const unitSummary = {
  id: 9,
  code: "FIT9999",
  name: "Example Unit",
};

export function test_readers_accept_minimal_cutover_payloads(): void {
  const projects = readProjects([{ id: 7, unit: unitSummary }]);
  assert.equal(projects[0]?.unit.code, "FIT9999");

  const project = readProject({ id: 7, unit: unitSummary, tasks: [] });
  assert.equal(project.target_grade, null);
  assert.deepEqual(project.tasks, []);

  const unit = readUnit({ ...unitSummary, task_definitions: [] });
  assert.deepEqual(unit.grade_definitions, []);

  const roles = readRoles([{ id: 4, role: "Tutor", unit: unitSummary }]);
  assert.equal(roles[0]?.user, null);
}

export function test_readers_retain_maximal_schedule_and_grade_fields(): void {
  const project = readProject({
    id: 7,
    unit: { ...unitSummary, allow_flexible_dates: true },
    target_grade: 2,
    submitted_grade: 1,
    compile_portfolio: true,
    portfolio_available: true,
    uses_draft_learning_summary: true,
    spec_con_days: 3,
    tasks: [{
      id: 11,
      task_definition_id: 12,
      status: "rediscuss",
      due_date: "2026-08-01",
      target_due_date: "2026-07-30",
      target_start_date: "2026-07-20",
      submission_date: "2026-07-29",
      completion_date: null,
      moved_to_discuss_at: "2026-07-25T01:00:00Z",
      discuss_timeout_expiry_at: "2026-07-26T01:00:00Z",
      extensions: 1,
      times_assessed: 2,
      grade: 1,
      quality_pts: 4,
      include_in_portfolio: true,
      num_new_comments: 3,
    }],
  });
  assert.equal(project.flexible_dates, true);
  assert.equal(project.special_consideration_days, 3);
  assert.equal(project.tasks[0]?.discuss_timeout_expiry_at?.toString(), "2026-07-26T01:00:00.000Z");
  assert.equal(project.tasks[0]?.num_new_comments, 3);

  const unit = readUnit({
    ...unitSummary,
    description: "Description",
    allow_flexible_dates: true,
    grade_definitions: [{ id: "hd", value: 3, label: "High Distinction", abbreviation: "HD" }],
    task_definitions: [{
      id: 12,
      abbreviation: "1.1",
      name: "Task",
      target_grade: 1,
      start_date: "2026-07-01",
      target_date: "2026-07-10",
      due_date: "2026-07-12",
      has_task_sheet: true,
      has_task_resources: false,
      upload_requirements: [
        { key: "file0", name: "Report", type: "document", submission_history: true },
        { key: "file1", name: "Source", type: "zip" },
      ],
      grade_due_dates: [{ target_grade: 2, target_due_date: "2026-07-09", start_date: "2026-07-02" }],
    }],
  });
  assert.equal(unit.grade_definitions[0]?.id, "hd");
  assert.equal(unit.task_definitions[0]?.grade_due_dates["2"]?.toString(), "2026-07-09");
  assert.equal(unit.task_definitions[0]?.grade_start_dates["2"]?.toString(), "2026-07-02");
  assert.equal(unit.task_definitions[0]?.has_task_sheet, true);
  assert.equal(unit.task_definitions[0]?.has_task_resources, false);
  assert.deepEqual(unit.task_definitions[0]?.upload_requirements, [
    { key: "file0", name: "Report", type: "document", submission_history: true },
    { key: "file1", name: "Source", type: "zip", submission_history: false },
  ]);
}

export function test_wrong_shapes_are_contract_errors_not_empty_successes(): void {
  for (const invalid of [{}, null, "[]"]) {
    assert.throws(() => readProjects(invalid), (error) => error instanceof CliError && error.category === "upstream_contract");
  }
  assert.throws(() => readProject({ id: 7, unit: unitSummary, tasks: {} }), /tasks must be an array/i);
  assert.throws(() => readUnit({ ...unitSummary, task_definitions: [], grade_definitions: {} }), /grade_definitions/i);
  assert.throws(() => readUnit({ ...unitSummary, task_definitions: [], grade_definitions: [] }), /grade_definitions/i);
  assert.throws(() => readRoles([{ id: "4", role: "Tutor", unit: unitSummary }]), /id must be a positive safe integer/i);
  assert.throws(
    () => readUnit({ ...unitSummary, task_definitions: [{ id: 1, abbreviation: "P1", name: "Task", upload_requirements: [{ key: "files[]", name: "Report", type: "document" }] }] }),
    /upload requirement key/u,
  );
  for (const id of [0, 7.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => readProjects([{ id, unit: unitSummary }]), /id must be a positive safe integer/i);
  }
}

export function test_task_comment_reader_validates_base_fields_and_preserves_subtype_data(): void {
  const comments = readTaskComments([{
    id: 41,
    comment: "Reviewed",
    has_attachment: false,
    type: "status",
    is_new: true,
    reply_to_id: null,
    author: { id: 2, first_name: "Example", last_name: "Tutor", email: "tutor@example.invalid" },
    recipient: { id: 1, first_name: "Example", last_name: "Student", email: "student@example.invalid" },
    created_at: "2026-07-28T01:02:03Z",
    recipient_read_time: null,
    status: "complete",
  }]);
  assert.equal(comments[0]?.created_at, "2026-07-28T01:02:03.000Z");
  assert.equal(comments[0]?.status, "complete");
  assert.throws(() => readTaskComments([{ id: 1 }]), (error) => error instanceof CliError && error.category === "upstream_contract");
}
