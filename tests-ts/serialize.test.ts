import assert from "node:assert/strict";

import { taskDefinitionToJson } from "../src/serialize.js";
import { CivilDate } from "../src/time.js";

export function test_start_only_grade_override_survives_serialization(): void {
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
  assert.deepEqual(json.grade_due_dates, [{ target_grade: 2, target_due_date: null, start_date: "2026-07-01" }]);
}
