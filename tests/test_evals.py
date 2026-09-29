"""Tests for the eval harness: fixtures and assertions, without a model."""

import importlib.util
import os
import shutil
import subprocess
import tempfile
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "run_evals", os.path.join(_REPO, "evals", "run_evals.py")
)
run_evals = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(run_evals)


class EvalHarnessTest(unittest.TestCase):

  def make(self, fixture):
    root = tempfile.mkdtemp()
    self.addCleanup(shutil.rmtree, root)
    run_evals.FIXTURES[fixture](root)
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, check=True,
                          capture_output=True, text=True).stdout.strip()
    return root, {"head": head, "snapshots": {}, "output": ""}

  def assert_check(self, root, assertion, context, expected=True):
    passed, detail = run_evals.check(root, assertion, context)
    self.assertEqual(bool(passed), expected, detail)

  def test_scenarios_reference_known_fixtures_and_assertions(self):
    for scenario in run_evals.load_scenarios():
      self.assertIn(scenario["fixture"], run_evals.FIXTURES)
      self.assertTrue(scenario["assertions"], scenario["name"])

  def test_every_fixture_is_healthy(self):
    for name in ("initialized", "with_track", "with_progress"):
      root, context = self.make(name)
      self.assert_check(root, {"type": "doctor_no_errors"}, context)
      self.assert_check(root, {"type": "tree_unchanged"}, context)

  def test_progress_fixture_assertions(self):
    root, context = self.make("with_progress")
    plan = "conductor/tracks/%s/plan.md" % run_evals.TRACK_ID
    context["snapshots"][plan] = run_evals._read(root, plan).splitlines()
    self.assert_check(root, {"type": "track_count", "count": 1}, context)
    self.assert_check(root, {"type": "task_status", "task": 1,
                             "status": "completed", "has_sha": True}, context)
    self.assert_check(root, {"type": "task_status", "task": 3,
                             "status": "completed"}, context, expected=False)
    self.assert_check(root, {"type": "lines_unchanged", "path": plan,
                             "marker": "[x]"}, context)

    # Rewriting a completed line must be detected.
    path = os.path.join(root, plan)
    with open(path, encoding="utf-8") as f:
      text = f.read()
    with open(path, "w", encoding="utf-8") as f:
      f.write(text.replace("Write failing tests", "Write tests"))
    self.assert_check(root, {"type": "lines_unchanged", "path": plan,
                             "marker": "[x]"}, context, expected=False)
    self.assert_check(root, {"type": "tree_unchanged"}, context,
                      expected=False)

  def test_learnings_fixture_is_recallable(self):
    root, context = self.make("with_learnings")
    self.assert_check(root, {"type": "doctor_no_errors"}, context)
    self.assert_check(root, {"type": "track_count", "count": 0}, context)
    recall = run_evals._state(root, "recall", "--query",
                              "Fahrenheit to Celsius conversion validation")
    self.assertEqual([m["id"] for m in recall["matches"]],
                     [run_evals.PAST_TRACK_ID])
    self.assertEqual(len(recall["conventions"]), 1)

  def test_any_track_file_contains(self):
    root, context = self.make("with_track")
    self.assert_check(root, {"type": "any_track_file_contains",
                             "file": "spec.md", "text": "Out of Scope"},
                      context)
    self.assert_check(root, {"type": "any_track_file_contains",
                             "file": "spec.md", "text": "Related Past Work"},
                      context, expected=False)

  def test_no_files_outside_prefix(self):
    root, context = self.make("initialized")
    run_evals._write(root, "conductor/tracks/x/spec.md", "# Spec\n")
    self.assert_check(root, {"type": "no_files_outside",
                             "prefix": "conductor/"}, context)
    run_evals._write(root, "tempconv/core.py", "")
    self.assert_check(root, {"type": "no_files_outside",
                             "prefix": "conductor/"}, context, expected=False)


if __name__ == "__main__":
  unittest.main()
