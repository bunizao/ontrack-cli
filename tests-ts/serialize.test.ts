import assert from "node:assert/strict";

import { taskDefinitionToJson, unitToJson } from "../src/serialize.js";
import { CivilDate } from "../src/time.js";

export function test_task_definition_keeps_grade_overrides_internal(): void {
  const json = taskDefinitionToJson({
    id: 1,
    abbreviation: "1",
    name: "Task",
    description: null,
    target_grade: null,
    start_date: null,
    target_date: null,
    due_date: null,
    is_graded: null,
    max_quality_pts: null,
    grade_due_dates: {},
    grade_start_dates: { "2": CivilDate.parse("2026-07-01") },
  });
  assert.equal("grade_due_dates" in json, false);
}

export function test_unit_keeps_grade_definitions_internal(): void {
  const json = unitToJson({
    id: 1,
    code: "FIT0001",
    name: "Example Unit",
    my_role: null,
    start_date: null,
    end_date: null,
    active: true,
    description: null,
    grade_definitions: [{ id: "mastery", value: 1, name: "Mastery", abbreviation: "M" }],
    task_definitions: [],
  });
  assert.equal("grade_definitions" in json, false);
}
