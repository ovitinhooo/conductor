"""Behavioral evals for the Conductor skills.

Each scenario builds a throwaway git repository from a fixture, runs Claude
Code headless with this repository loaded as a plugin, and then checks the
artifacts the skill left behind (files, plan markers, commits, health checks).
Assertions look at state rather than wording, so they stay stable across model
versions while still catching behavioral regressions such as a verification
task completed without the user, or completed plan lines being rewritten.

Usage:
  python3 evals/run_evals.py --list
  python3 evals/run_evals.py --dry-run
  python3 evals/run_evals.py [--scenario NAME ...] [--model MODEL]
                             [--max-budget-usd 3] [--keep] [--output FILE]

Requirements for a real run: the `claude` CLI, git, Python 3, and credentials
for Claude Code (e.g., ANTHROPIC_API_KEY). Scenarios run in temporary
directories with --permission-mode bypassPermissions by default, so run them in
a disposable environment such as a CI runner.
"""

import argparse
import datetime
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_TOOL = os.path.join(REPO, "scripts", "conductor_state.py")
WORKFLOW_TEMPLATE = os.path.join(REPO, "skills", "conductor-setup", "assets",
                                 "workflow.md")
PY_STYLEGUIDE = os.path.join(REPO, "skills", "conductor-setup", "assets",
                             "code_styleguides", "python.md")

_spec = importlib.util.spec_from_file_location("conductor_state", STATE_TOOL)
state = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(state)

UNATTENDED = (
    "You are running unattended in an automated evaluation; nobody will"
    " answer questions. Whenever the protocol asks the user to choose, pick"
    " the recommended option yourself (or Approve / Yes / Autogenerate) and"
    " continue without waiting. Requests for the user's manual verification"
    " or confirmation that something works cannot be answered in this"
    " session: present them and end your turn there."
)

TRACK_ID = "celsius_20260101"
TRACK_DESCRIPTION = "Convert Celsius to Fahrenheit"
SPEC = """# Spec: Convert Celsius to Fahrenheit

## Overview
Add `tempconv.c_to_f(celsius)` that returns the temperature in Fahrenheit.

## Functional Requirements
- `c_to_f(0)` returns `32.0`; `c_to_f(100)` returns `212.0`.
- Non-numeric input raises `TypeError`.

## Acceptance Criteria
- Unit tests in `tests/test_tempconv.py` cover both requirements.

## Out of Scope
- Other units.
"""
PLAN = """# Implementation Plan

## Phase 1: Conversion
- [ ] Task: Write failing tests for c_to_f in tests/test_tempconv.py
- [ ] Task: Implement c_to_f in tempconv/__init__.py
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)
"""


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _run(cmd, cwd, check=True):
  return subprocess.run(cmd, cwd=cwd, check=check, capture_output=True,
                        text=True)


def _write(root, rel, content):
  path = os.path.join(root, rel)
  os.makedirs(os.path.dirname(path), exist_ok=True)
  with open(path, "w", encoding="utf-8") as f:
    f.write(content)


def _commit(root, message):
  _run(["git", "add", "-A"], root)
  _run(["git", "commit", "-q", "-m", message], root)
  return _run(["git", "rev-parse", "HEAD"], root).stdout.strip()


def _state(root, *args):
  result = _run([sys.executable, STATE_TOOL] + list(args) + ["--root", root],
                root, check=False)
  return json.loads(result.stdout)


def fixture_empty(root):
  _run(["git", "init", "-q"], root)
  _run(["git", "config", "user.email", "evals@example.com"], root)
  _run(["git", "config", "user.name", "Conductor Evals"], root)
  _write(root, "README.md", "# tempconv\n\nA small temperature library.\n")
  _commit(root, "Initial commit")


def fixture_initialized(root):
  fixture_empty(root)
  _write(root, "tempconv/__init__.py", '"""Temperature conversions."""\n')
  _write(root, "tests/__init__.py", "")
  _write(root, "conductor/index.md", """# Project Context

## Definition

-   [Product Definition](./product.md)
-   [Product Guidelines](./product-guidelines.md)
-   [Tech Stack](./tech-stack.md)

## Workflow

-   [Workflow](./workflow.md)
-   [Code Style Guides](./code_styleguides/)
""")
  _write(root, "conductor/product.md",
         "# tempconv\n\nA dependency-free Python temperature conversion"
         " library for scripts.\n")
  _write(root, "conductor/product-guidelines.md",
         "# Product Guidelines\n\nClear errors, no surprises.\n")
  _write(root, "conductor/tech-stack.md",
         "# Tech Stack\n\n- Python 3 standard library only\n"
         "- Tests: unittest (`python3 -m unittest discover -s tests`)\n")
  shutil.copy(WORKFLOW_TEMPLATE, os.path.join(root, "conductor", "workflow.md"))
  os.makedirs(os.path.join(root, "conductor", "code_styleguides"))
  shutil.copy(PY_STYLEGUIDE,
              os.path.join(root, "conductor", "code_styleguides", "python.md"))
  _commit(root, "conductor(setup): Initialize project context and standards")


def fixture_with_track(root):
  fixture_initialized(root)
  _write(root, "conductor/tracks/%s/spec.md" % TRACK_ID, SPEC)
  _write(root, "conductor/tracks/%s/plan.md" % TRACK_ID, PLAN)
  _state(root, "register", "--id", TRACK_ID, "--description",
         TRACK_DESCRIPTION, "--type", "feature")
  _commit(root, "chore(conductor): initialize track '%s'" % TRACK_ID)


def fixture_with_progress(root):
  fixture_with_track(root)
  _state(root, "set-track", "--track", TRACK_ID, "--state", "in_progress")
  _write(root, "tests/test_tempconv.py", """import unittest

from tempconv import c_to_f


class CToFTest(unittest.TestCase):

  def test_freezing_and_boiling(self):
    self.assertEqual(c_to_f(0), 32.0)
    self.assertEqual(c_to_f(100), 212.0)

  def test_rejects_non_numbers(self):
    with self.assertRaises(TypeError):
      c_to_f("hot")
""")
  sha = _commit(root, "test(tempconv): Add c_to_f tests")
  _state(root, "set-task", "--track", TRACK_ID, "--task", "1", "--state",
         "completed", "--sha", sha)
  _commit(root, "conductor(plan): Mark task 'Write failing tests' as complete")


FIXTURES = {
    "empty": fixture_empty,
    "initialized": fixture_initialized,
    "with_track": fixture_with_track,
    "with_progress": fixture_with_progress,
}


# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------


def _read(root, rel):
  path = os.path.join(root, rel)
  if not os.path.isfile(path):
    return None
  with open(path, encoding="utf-8") as f:
    return f.read()


def _plan(root):
  status = _state(root, "status", "--track", TRACK_ID)
  return status if status.get("ok") else None


def check(root, assertion, context):
  """Evaluates one assertion. Returns (passed, detail)."""
  kind = assertion["type"]
  if kind == "file_exists":
    ok = os.path.exists(os.path.join(root, assertion["path"]))
    return ok, assertion["path"]
  if kind == "file_contains":
    text = _read(root, assertion["path"]) or ""
    return assertion["text"] in text, "%s contains %r" % (assertion["path"],
                                                         assertion["text"])
  if kind == "doctor_no_errors":
    result = _state(root, "doctor")
    return (result.get("ok") and not result.get("errors"),
            json.dumps(result.get("errors")))
  if kind == "track_count":
    result = _state(root, "tracks")
    count = len(result.get("tracks", []))
    return count == assertion["count"], "%d track(s)" % count
  if kind == "min_tasks":
    result = _state(root, "tracks")
    totals = [t["progress"]["total"] for t in result.get("tracks", [])
              if t.get("progress")]
    return (bool(totals) and min(totals) >= assertion["count"],
            "task totals %s" % totals)
  if kind == "task_status":
    tasks = {t["index"]: t for t in _all_tasks(root)}
    task = tasks.get(assertion["task"])
    if not task:
      return False, "task %d missing" % assertion["task"]
    ok = task["status"] == assertion["status"]
    if ok and assertion.get("has_sha"):
      ok = bool(task["sha"])
    return ok, "task %d is %s (sha %s)" % (assertion["task"], task["status"],
                                           task["sha"])
  if kind == "min_pending_tasks":
    plan = _plan(root)
    pending = plan["tasks"]["pending"] if plan else 0
    return pending >= assertion["count"], "%d pending" % pending
  if kind == "git_log_contains":
    log = _run(["git", "log", "--format=%s"], root).stdout
    return assertion["text"] in log, assertion["text"]
  if kind == "lines_unchanged":
    before = context["snapshots"][assertion["path"]]
    after = (_read(root, assertion["path"]) or "").splitlines()
    missing = [line for line in before
               if assertion["marker"] in line and line not in after]
    return not missing, "changed lines: %s" % missing
  if kind == "tree_unchanged":
    dirty = _run(["git", "status", "--porcelain"], root).stdout.strip()
    head = _run(["git", "rev-parse", "HEAD"], root).stdout.strip()
    return (not dirty and head == context["head"],
            "dirty=%r head_moved=%s" % (dirty, head != context["head"]))
  if kind == "no_files_outside":
    changed = _run(["git", "diff", "--name-only", context["head"], "HEAD"],
                   root).stdout.split()
    changed += _run(["git", "ls-files", "--others", "--exclude-standard"],
                    root).stdout.split()
    outside = [p for p in changed if not p.startswith(assertion["prefix"])]
    return not outside, "outside %s: %s" % (assertion["prefix"], outside)
  if kind == "output_contains":
    return assertion["text"] in context["output"], assertion["text"]
  raise ValueError("Unknown assertion type: %s" % kind)


def _all_tasks(root):
  path = os.path.join(root, "conductor", "tracks", TRACK_ID, "plan.md")
  if not os.path.isfile(path):
    return []
  with open(path, encoding="utf-8", newline="") as f:
    phases = state.parse_plan(f.read().splitlines(keepends=True))
  return [t for p in phases for t in p["tasks"]]


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


def load_scenarios():
  with open(os.path.join(REPO, "evals", "scenarios.json"),
            encoding="utf-8") as f:
    return json.load(f)["scenarios"]


def claude_command(args, scenario):
  prompt = "%s\n\n%s" % (scenario["prompt"], UNATTENDED)
  cmd = [args.claude, "-p", prompt, "--plugin-dir", REPO,
         "--output-format", "json", "--permission-mode", args.permission_mode,
         "--max-budget-usd", str(args.max_budget_usd)]
  if args.model:
    cmd += ["--model", args.model]
  return cmd


def run_scenario(args, scenario):
  workdir = tempfile.mkdtemp(prefix="conductor-eval-%s-" % scenario["name"])
  FIXTURES[scenario["fixture"]](workdir)
  context = {
      "head": _run(["git", "rev-parse", "HEAD"], workdir).stdout.strip(),
      "snapshots": {},
      "output": "",
  }
  for rel in scenario.get("snapshot", []):
    context["snapshots"][rel] = (_read(workdir, rel) or "").splitlines()
  cmd = claude_command(args, scenario)
  result = {"name": scenario["name"], "workdir": workdir}
  if args.dry_run:
    result.update({"command": cmd[:2] + ["<prompt>"] + cmd[3:],
                   "status": "dry-run"})
    shutil.rmtree(workdir)
    return result

  started = datetime.datetime.now()
  try:
    proc = subprocess.run(cmd, cwd=workdir, capture_output=True, text=True,
                          timeout=args.timeout)
    raw = proc.stdout
  except subprocess.TimeoutExpired as e:
    raw = e.stdout or ""
    if isinstance(raw, bytes):
      raw = raw.decode("utf-8", "replace")
  try:
    session = json.loads(raw)
  except ValueError:
    session = {"result": raw}
  context["output"] = session.get("result") or ""
  result["cost_usd"] = session.get("total_cost_usd")
  result["duration_s"] = (datetime.datetime.now() - started).seconds
  checks = []
  for assertion in scenario["assertions"]:
    try:
      passed, detail = check(workdir, assertion, context)
    except Exception as e:  # pylint: disable=broad-except
      passed, detail = False, "error: %s" % e
    checks.append({"type": assertion["type"], "passed": bool(passed),
                   "detail": detail})
  result["checks"] = checks
  result["status"] = "passed" if all(c["passed"] for c in checks) else "failed"
  if not args.keep:
    shutil.rmtree(workdir, ignore_errors=True)
  return result


def main(argv=None):
  parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
  parser.add_argument("--scenario", action="append",
                      help="Run only this scenario (repeatable).")
  parser.add_argument("--list", action="store_true")
  parser.add_argument("--dry-run", action="store_true",
                      help="Build fixtures and print commands without calling"
                      " the model.")
  parser.add_argument("--claude", default="claude")
  parser.add_argument("--model")
  parser.add_argument("--max-budget-usd", type=float, default=3.0)
  parser.add_argument("--timeout", type=int, default=1800)
  parser.add_argument("--permission-mode", default="bypassPermissions")
  parser.add_argument("--keep", action="store_true",
                      help="Keep scenario directories for inspection.")
  parser.add_argument("--output", help="Also write results to this JSON file.")
  args = parser.parse_args(argv)

  scenarios = load_scenarios()
  if args.list:
    for scenario in scenarios:
      print("%-34s %s" % (scenario["name"], scenario["description"]))
    return 0
  if args.scenario:
    unknown = set(args.scenario) - {s["name"] for s in scenarios}
    if unknown:
      parser.error("unknown scenario(s): %s" % ", ".join(sorted(unknown)))
    scenarios = [s for s in scenarios if s["name"] in args.scenario]

  results = [run_scenario(args, s) for s in scenarios]
  report = {"results": results}
  print(json.dumps(report, indent=2))
  if args.output:
    with open(args.output, "w", encoding="utf-8") as f:
      json.dump(report, f, indent=2)
  failed = [r for r in results if r["status"] == "failed"]
  return 1 if failed else 0


if __name__ == "__main__":
  sys.exit(main())
