"""Shared constants for ontrack-cli."""

CONFIG_DIR = "~/.config/ontrack-cli"
CONFIG_FILENAME = "config.yaml"
ENV_ONTRACK_BASE_URL = "ONTRACK_BASE_URL"
ENV_ONTRACK_USERNAME = "ONTRACK_USERNAME"
ENV_ONTRACK_AUTH_TOKEN = "ONTRACK_AUTH_TOKEN"
ENV_ONTRACK_USER_JSON = "ONTRACK_DOUBTFIRE_USER_JSON"
ENV_ONTRACK_CONFIG = "ONTRACK_CONFIG"
DEFAULT_TIMEOUT = 30

ACTIVE_TASK_STATUSES = {
    "not_started",
    "working_on_it",
    "need_help",
    "redo",
    "fix_and_resubmit",
    "ready_for_feedback",
    "discuss",
    "demonstrate",
}

FINAL_TASK_STATUSES = {
    "complete",
    "fail",
    "feedback_exceeded",
    "time_exceeded",
}

SUBMITTED_TASK_STATUSES = {
    "feedback_exceeded",
    "ready_for_feedback",
    "discuss",
    "demonstrate",
    "complete",
    "fail",
    "time_exceeded",
}

TASK_STATUS_LABELS = {
    "ready_for_feedback": "Ready for Feedback",
    "not_started": "Not Started",
    "working_on_it": "Working On It",
    "need_help": "Need Help",
    "redo": "Redo",
    "feedback_exceeded": "Feedback Exceeded",
    "fix_and_resubmit": "Resubmit",
    "discuss": "Discuss",
    "demonstrate": "Demonstrate",
    "complete": "Complete",
    "fail": "Fail",
    "time_exceeded": "Time Exceeded",
}

GRADE_LABELS = {
    -1: "Fail",
    0: "Pass",
    1: "Credit",
    2: "Distinction",
    3: "High Distinction",
}

GRADE_ACRONYMS = {
    -1: "F",
    0: "P",
    1: "C",
    2: "D",
    3: "HD",
}
