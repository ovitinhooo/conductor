"""Tests for scripts/conductor_state.py."""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import tempfile
import unittest

_SCRIPT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "scripts", "conductor_state.py",
)
_spec = importlib.util.spec_from_file_location("conductor_state", _SCRIPT)
state = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(state)

INDEX = """# Project Context

## Definition

-   [Product Definition](./product.md)
-   [Product Guidelines](./product-guidelines.md)
-   [Tech Stack](./tech-stack.md)

## Workflow

-   [Workflow](./workflow.md)
-   [Code Style Guides](./code_styleguides/)
"""

PLAN = """# Implementation Plan

## Phase 1: Core
- [x] Task: Write tests for parser abc1234
    - [x] Cover empty input
- [x] Task: Implement parser 1234567
- [x] Task: Phase Verification & Checkpoint (Refer to workflow.md)

## Phase 2: CLI
- [~] Task: Add CLI entry point
    - [ ] Parse arguments
    - [ ] Print help
- [ ] Task: Document CLI
- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)
"""


class ConductorStateTest(unittest.TestCase):

  def setUp(self):
    self.root = tempfile.mkdtemp()
    self.addCleanup(shutil.rmtree, self.root)
    self.cdir = os.path.join(self.root, "conductor")
    os.makedirs(self.cdir)
    self.write("conductor/index.md", INDEX)
    for name in ("product.md", "product-guidelines.md", "tech-stack.md",
                 "workflow.md"):
      self.write("conductor/" + name, "# %s\n" % name)

  # Helpers -----------------------------------------------------------------

  def write(self, rel, content):
    path = os.path.join(self.root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
      f.write(content)
    return path

  def read(self, rel):
    with open(os.path.join(self.root, rel), encoding="utf-8", newline="") as f:
      return f.read()

  def run_cli(self, *argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
      code = state.main(list(argv) + ["--root", self.root])
    return code, json.loads(out.getvalue())

  def ok(self, *argv):
    code, result = self.run_cli(*argv)
    self.assertEqual(code, 0, result)
    self.assertTrue(result["ok"])
    return result

  def fail(self, *argv):
    code, result = self.run_cli(*argv)
    self.assertEqual(code, 1, result)
    self.assertFalse(result["ok"])
    return result["error"]

  def make_track(self, track_id="cli_20260101", plan=PLAN, register=True):
    self.write("conductor/tracks/%s/spec.md" % track_id, "# Spec\n")
    self.write("conductor/tracks/%s/plan.md" % track_id, plan)
    if register:
      self.ok("register", "--id", track_id, "--description", "Build the CLI")
    return track_id

  # Parsing -----------------------------------------------------------------

  def test_parse_registry_supports_standard_and_legacy_formats(self):
    lines = io.StringIO(
        "# Project Tracks\n\n---\n\n"
        "- [~] **Track: New format**\n"
        "*Link: [./tracks/a/index.md](./tracks/a/index.md)*\n\n---\n\n"
        "## [x] Track: Legacy format\n"
        "*Link: [./tracks/b/](./tracks/b/)*\n"
    ).readlines()
    entries = state.parse_registry(lines)
    self.assertEqual(
        [(e["description"], e["status"], e["link"]) for e in entries],
        [("New format", "in_progress", "./tracks/a/index.md"),
         ("Legacy format", "completed", "./tracks/b/")],
    )

  def test_parse_plan_tasks_subtasks_shas_and_phases(self):
    phases = state.parse_plan(io.StringIO(PLAN).readlines())
    self.assertEqual([p["title"] for p in phases], ["Phase 1: Core",
                                                     "Phase 2: CLI"])
    first = phases[0]["tasks"][0]
    self.assertEqual(first["text"], "Task: Write tests for parser")
    self.assertEqual(first["sha"], "abc1234")
    self.assertEqual(len(first["subtasks"]), 1)
    self.assertEqual(phases[1]["tasks"][0]["index"], 4)
    self.assertEqual(len(phases[1]["tasks"][0]["subtasks"]), 2)

  def test_trailing_hex_word_without_digit_is_not_a_sha(self):
    phases = state.parse_plan(["## P\n", "- [x] Task: Remove defaced\n"])
    task = phases[0]["tasks"][0]
    self.assertEqual(task["text"], "Task: Remove defaced")
    self.assertIsNone(task["sha"])

  def test_checkpoint_is_parsed_from_heading(self):
    phases = state.parse_plan(
        ["## Phase 1: Core [checkpoint: 89abcde]\n", "- [x] Task: A 1234567\n"]
    )
    self.assertEqual(phases[0]["title"], "Phase 1: Core")
    self.assertEqual(phases[0]["checkpoint"], "89abcde")

  # Registration --------------------------------------------------------------

  def test_register_creates_files_registry_entry_and_index_section(self):
    track_id = self.make_track()
    metadata = json.loads(self.read("conductor/tracks/%s/metadata.json"
                                    % track_id))
    self.assertEqual(metadata["status"], "new")
    self.assertEqual(metadata["track_id"], track_id)
    registry = self.read("conductor/tracks.md")
    self.assertIn("- [ ] **Track: Build the CLI**", registry)
    self.assertIn("(./tracks/%s/index.md)" % track_id, registry)
    self.assertIn("[Tracks Registry](./tracks.md)",
                  self.read("conductor/index.md"))
    self.assertTrue(os.path.isfile(
        os.path.join(self.cdir, "tracks", track_id, "index.md")))

  def test_register_rejects_duplicates(self):
    track_id = self.make_track()
    self.assertIn("already registered",
                  self.fail("register", "--id", track_id, "--description",
                            "Again"))

  def test_new_id_avoids_collisions(self):
    self.make_track("login_20260101")
    result = self.ok("new-id", "--short-name", "Login", "--date", "20260101")
    self.assertEqual(result["id"], "login_20260101_2")

  # Task progression ----------------------------------------------------------

  def test_next_task_resumes_in_progress_task(self):
    track_id = self.make_track()
    result = self.ok("next-task", "--track", track_id)
    self.assertTrue(result["resume"])
    self.assertEqual(result["task"]["index"], 4)
    self.assertEqual(result["task"]["phase_number"], 2)
    self.assertFalse(result["task"]["is_last_in_phase"])

  def test_set_task_completed_records_sha_and_updates_metadata(self):
    track_id = self.make_track()
    result = self.ok("set-task", "--track", track_id, "--task", "4",
                     "--state", "completed", "--sha", "fedcba9876543",
                     "--cascade")
    self.assertFalse(result["phase_complete"])
    plan = self.read("conductor/tracks/%s/plan.md" % track_id)
    self.assertIn("- [x] Task: Add CLI entry point fedcba9\n", plan)
    self.assertIn("    - [x] Parse arguments\n", plan)
    metadata = json.loads(self.read("conductor/tracks/%s/metadata.json"
                                    % track_id))
    self.assertEqual(metadata["status"], "in_progress")

  def test_set_task_pending_strips_sha(self):
    track_id = self.make_track()
    self.ok("set-task", "--track", track_id, "--task", "2", "--state",
            "pending")
    plan = self.read("conductor/tracks/%s/plan.md" % track_id)
    self.assertIn("- [ ] Task: Implement parser\n", plan)

  def test_verification_task_requires_user_confirmation(self):
    track_id = self.make_track()
    error = self.fail("set-task", "--track", track_id, "--task", "6",
                      "--state", "completed")
    self.assertIn("--user-confirmed", error)
    self.ok("set-task", "--track", track_id, "--task", "6", "--state",
            "completed", "--user-confirmed")

  def test_set_task_rejects_non_sha(self):
    track_id = self.make_track()
    self.assertIn("not a commit SHA",
                  self.fail("set-task", "--track", track_id, "--task", "4",
                            "--state", "completed", "--sha", "HEAD"))

  def test_set_task_preserves_crlf_line_endings(self):
    track_id = self.make_track(plan=PLAN.replace("\n", "\r\n"))
    self.ok("set-task", "--track", track_id, "--task", "5", "--state",
            "in_progress")
    plan = self.read("conductor/tracks/%s/plan.md" % track_id)
    self.assertNotIn("\n", plan.replace("\r\n", ""))
    self.assertIn("- [~] Task: Document CLI\r\n", plan)

  def test_set_checkpoint_replaces_existing_checkpoint(self):
    track_id = self.make_track()
    self.ok("set-checkpoint", "--track", track_id, "--phase", "1", "--sha",
            "1111111aaaa")
    self.ok("set-checkpoint", "--track", track_id, "--phase", "1", "--sha",
            "2222222")
    plan = self.read("conductor/tracks/%s/plan.md" % track_id)
    self.assertIn("## Phase 1: Core [checkpoint: 2222222]\n", plan)
    self.assertNotIn("1111111", plan)

  # Track status ----------------------------------------------------------

  def test_set_track_completed_requires_finished_plan(self):
    track_id = self.make_track()
    self.assertIn("unfinished task",
                  self.fail("set-track", "--track", track_id, "--state",
                            "completed"))
    self.ok("set-track", "--track", track_id, "--state", "completed",
            "--force")
    self.assertIn("- [x] **Track: Build the CLI**",
                  self.read("conductor/tracks.md"))

  def test_status_reports_active_track(self):
    track_id = self.make_track()
    self.ok("set-track", "--track", track_id, "--state", "in_progress")
    result = self.ok("status")
    self.assertEqual(result["active_track"]["id"], track_id)
    self.assertEqual(result["active_plan"]["tasks"]["completed"], 3)
    self.assertEqual(result["active_plan"]["current_task"]["index"], 4)

  def test_find_track_by_description(self):
    track_id = self.make_track()
    result = self.ok("status", "--track", "build the cli")
    self.assertEqual(result["track"]["id"], track_id)

  def test_archive_moves_track_and_removes_registry_entry(self):
    done = self.make_track("done_20260101", plan="## P\n- [x] Task: A 1234567\n")
    keep = self.make_track("keep_20260102")
    self.ok("set-track", "--track", done, "--state", "completed")
    result = self.ok("archive", "--track", done)
    self.assertEqual(result["archived_to"], "conductor/archive/%s" % done)
    registry = self.read("conductor/tracks.md")
    self.assertNotIn(done, registry)
    self.assertIn(keep, registry)
    self.assertEqual(registry.count("---"), 1)
    self.assertTrue(os.path.isdir(os.path.join(self.cdir, "archive", done)))

  def test_archive_refuses_unfinished_track(self):
    track_id = self.make_track()
    self.assertIn("not completed", self.fail("archive", "--track", track_id))

  def test_legacy_root_relative_links_are_resolved(self):
    self.write("conductor/tracks/old/plan.md", PLAN)
    self.write("conductor/tracks/old/spec.md", "# Spec\n")
    self.write("conductor/tracks.md",
               "# Project Tracks\n\n---\n\n## [~] Track: Old track\n"
               "*Link: [./conductor/tracks/old/](./conductor/tracks/old/)*\n")
    result = self.ok("next-task", "--track", "old")
    self.assertEqual(result["task"]["index"], 4)

  def test_next_task_can_defer_verification_tasks(self):
    plan = ("## Phase 1\n- [x] Task: A 1234567\n"
            "- [ ] Task: Phase Verification & Checkpoint\n"
            "## Phase 2\n- [ ] Task: B\n"
            "- [ ] Task: Phase Verification & Checkpoint\n")
    track_id = self.make_track(plan=plan)
    result = self.ok("next-task", "--track", track_id, "--skip-verification")
    self.assertEqual(result["task"]["text"], "Task: B")
    self.ok("set-task", "--track", track_id, "--task", "3", "--state",
            "completed", "--sha", "abcdef1")
    result = self.ok("next-task", "--track", track_id, "--skip-verification")
    self.assertIsNone(result["task"])
    self.assertFalse(result["track_complete"])
    self.assertEqual([t["index"] for t in result["deferred_verification_tasks"]],
                     [2, 4])

  # Settings ----------------------------------------------------------------

  def test_settings_default_when_section_missing(self):
    result = self.ok("settings")
    self.assertEqual(result["settings"], {"autonomy": "phase",
                                          "delegation": "auto"})

  def test_settings_read_from_workflow(self):
    self.write("conductor/workflow.md",
               "# Project Workflow\n\n## Execution Settings\n\n"
               "-   **Autonomy:** `track`\n"
               "    -   `step`: pause after every task.\n"
               "-   **Delegation:** `bogus`\n\n"
               "## Task Workflow\n\n-   **Autonomy:** `step`\n")
    result = self.ok("settings")
    self.assertEqual(result["settings"]["autonomy"], "track")
    self.assertEqual(result["settings"]["delegation"], "auto")
    self.assertIn("delegation=bogus", result["warnings"][0])

  # Doctor ------------------------------------------------------------------

  def test_doctor_healthy_project(self):
    self.make_track()
    result = self.ok("doctor")
    self.assertTrue(result["healthy"])
    self.assertEqual(result["errors"], [])

  def test_doctor_reports_and_fixes_inconsistencies(self):
    track_id = self.make_track()
    os.makedirs(os.path.join(self.cdir, "tracks", "orphan"))
    os.remove(os.path.join(self.cdir, "tech-stack.md"))
    self.ok("set-track", "--track", track_id, "--state", "in_progress")
    self.write("conductor/tracks/%s/metadata.json" % track_id,
               json.dumps({"status": "completed"}))
    result = self.ok("doctor")
    self.assertFalse(result["healthy"])
    codes = {i["code"] for i in result["errors"] + result["warnings"]}
    self.assertIn("missing_core_file", codes)
    self.assertIn("unregistered_track", codes)
    self.assertIn("metadata_status_mismatch", codes)

    fixed = self.ok("doctor", "--fix")
    self.assertTrue(fixed["fixed"])
    metadata = json.loads(self.read("conductor/tracks/%s/metadata.json"
                                    % track_id))
    self.assertEqual(metadata["status"], "in_progress")

  def test_doctor_without_conductor_dir(self):
    shutil.rmtree(self.cdir)
    result = self.ok("doctor")
    self.assertEqual(result["errors"][0]["code"], "missing_conductor_dir")


if __name__ == "__main__":
  unittest.main()
