import assert from "node:assert/strict";

import { gradeLabel, readGradeDefinitions } from "../src/grades.js";
import { buildProjectSnapshot } from "../src/project-snapshot.js";
import { isFinalStatus, isSubmittedStatus, statusLabel } from "../src/status.js";
import { CivilDate, createClock, Instant } from "../src/time.js";
import type { Project, Unit } from "../src/types.js";

export function test_civil_dates_compare_without_manufacturing_instants(): void {
  const earlier = CivilDate.parse("2026-07-01");
  const later = CivilDate.parse("2026-07-02");
  assert.equal(earlier.compare(later), -1);
  assert.equal(later.compare(earlier), 1);
  assert.equal(CivilDate.parse("2026-07-01").toString(), "2026-07-01");
  assert.throws(() => CivilDate.parse("2026-7-1"), /civil date/i);
}

export function test_instants_remain_distinct_from_civil_dates(): void {
  const instant = Instant.parse("2026-07-01T02:03:04Z");
  assert.equal(instant.toString(), "2026-07-01T02:03:04.000Z");
  assert.equal(instant.compare(Instant.parse("2026-07-01T03:03:04+00:00")), -1);
  assert.throws(() => Instant.parse("2026-07-01"), /instant/i);
}

export function test_clock_override_controls_now_and_local_today(): void {
  const clock = createClock("2026-07-26T23:30:00+08:00");
  assert.equal(clock.now.toString(), "2026-07-26T15:30:00.000Z");
  assert.equal(clock.today.toString(), "2026-07-26");
}

export function test_status_catalog_includes_current_upstream_states(): void {
  assert.equal(isFinalStatus("assess_in_portfolio"), true);
  assert.equal(isSubmittedStatus("assess_in_portfolio"), true);
  assert.equal(isSubmittedStatus("attention_required"), true);
  assert.equal(isSubmittedStatus("rediscuss"), true);
  assert.equal(statusLabel("rediscuss"), "Rediscuss");
}

export function test_unknown_status_round_trips_with_safe_label(): void {
  const key = "future_status_2027";
  assert.equal(statusLabel(key), key);
  assert.equal(isFinalStatus(key), false);
  assert.equal(isSubmittedStatus(key), false);
}

export function test_unit_grades_override_historical_fallback(): void {
  const definitions = readGradeDefinitions([
    { id: "satisfactory", value: 0, label: "Satisfactory", abbreviation: "S" },
    { id: "mastery", value: 1, label: "Mastery", abbreviation: "M" },
  ]);
  assert.equal(gradeLabel(1, definitions), "M (Mastery)");
  assert.equal(gradeLabel(3, []), "HD (High Distinction)");
  assert.equal(gradeLabel(99, definitions), "99");
}

export function test_project_snapshot_applies_schedule_precedence_and_total_order(): void {
  const project: Project = {
    id: 7,
    unit: { id: 3, code: "FIT9999", name: "Example" },
    target_grade: 1,
    submitted_grade: null,
    compile_portfolio: false,
    portfolio_available: false,
    uses_draft_learning_summary: false,
    flexible_dates: true,
    special_consideration_days: 2,
    tasks: [
      {
        id: 22,
        task_definition_id: 102,
        status: "not_started",
        due_date: CivilDate.parse("2026-08-10"),
        target_due_date: CivilDate.parse("2026-08-04"),
        target_start_date: null,
        submission_date: null,
        completion_date: null,
        moved_to_discuss_at: null,
        discuss_timeout_expiry_at: null,
        extensions: null,
        times_assessed: null,
        grade: null,
        quality_pts: null,
        include_in_portfolio: false,
      },
      {
        id: 21,
        task_definition_id: 101,
        status: "assess_in_portfolio",
        due_date: CivilDate.parse("2026-07-01"),
        target_due_date: null,
        target_start_date: null,
        submission_date: null,
        completion_date: null,
        moved_to_discuss_at: null,
        discuss_timeout_expiry_at: null,
        extensions: null,
        times_assessed: null,
        grade: 1,
        quality_pts: null,
        include_in_portfolio: true,
      },
    ],
  };
  const unit: Unit = {
    id: 3,
    code: "FIT9999",
    name: "Example",
    grade_definitions: [{ id: "mastery", value: 1, name: "Mastery", abbreviation: "M" }],
    task_definitions: [
      {
        id: 101,
        abbreviation: "A",
        name: "First",
        target_grade: 1,
        start_date: null,
        target_date: CivilDate.parse("2026-07-01"),
        due_date: CivilDate.parse("2026-07-01"),
        grade_due_dates: { "1": CivilDate.parse("2026-07-05") },
        grade_start_dates: {},
      },
      {
        id: 102,
        abbreviation: "B",
        name: "Second",
        target_grade: 1,
        start_date: null,
        target_date: CivilDate.parse("2026-08-20"),
        due_date: CivilDate.parse("2026-08-20"),
        grade_due_dates: { "1": CivilDate.parse("2026-08-15") },
        grade_start_dates: {},
      },
    ],
  };

  const rows = buildProjectSnapshot(project, unit, createClock("2026-07-26T12:00:00+08:00")).tasks;
  assert.equal(rows[0]?.id, 21);
  assert.equal(rows[0]?.due_date, "2026-07-05");
  assert.equal(rows[0]?.deadline, "2026-07-03");
  assert.equal(rows[0]?.is_overdue, false);
  assert.equal(rows[1]?.due_date, "2026-08-04");
  assert.equal(rows[1]?.deadline, "2026-08-22");
}
