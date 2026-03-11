"""Structured output helpers."""

from __future__ import annotations

import json
import sys

import yaml


def output_json(data: object) -> None:
    """Write JSON to stdout."""
    json.dump(data, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


def output_yaml(data: object) -> None:
    """Write YAML to stdout."""
    yaml.safe_dump(data, sys.stdout, sort_keys=False, allow_unicode=True)
