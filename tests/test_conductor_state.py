"""Tests for scripts/conductor_state.py."""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

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
    env = mock.patch.dict(os.environ)
    env.start()
    self.addCleanup(env.stop)
    os.environ.pop(state.CONDUCTOR_DIR_ENV, None)
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

  def fails(self, *argv):
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

  def test_numbers_and_quoted_shas(self):
    phases = state.parse_plan([
        "## P\n",
        "- [x] Task: Apply migration 20260315\n",
        "- [x] Task: Numeric sha [1234567]\n",
        "- [x] Task: Backticked `abcdef0123`\n",
    ])
    tasks = phases[0]["tasks"]
    self.assertEqual((tasks[0]["text"], tasks[0]["sha"]),
                     ("Task: Apply migration 20260315", None))
    self.assertEqual(tasks[1]["sha"], "1234567")
    self.assertEqual(tasks[2]["sha"], "abcdef0123")

  def test_reset_keeps_numbers_that_are_not_shas(self):
    track_id = self.make_track(
        plan="## P\n- [x] Task: Apply migration 20260315\n")
    self.ok("set-task", "--track", track_id, "--task", "1", "--state",
            "pending")
    self.assertIn("- [ ] Task: Apply migration 20260315\n",
                  self.read("conductor/tracks/%s/plan.md" % track_id))

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
                  self.fails("register", "--id", track_id, "--description",
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
    error = self.fails("set-task", "--track", track_id, "--task", "6",
                      "--state", "completed")
    self.assertIn("--user-confirmed", error)
    self.ok("set-task", "--track", track_id, "--task", "6", "--state",
            "completed", "--user-confirmed")

  def test_set_task_rejects_non_sha(self):
    track_id = self.make_track()
    self.assertIn("not a commit SHA",
                  self.fails("set-task", "--track", track_id, "--task", "4",
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
                  self.fails("set-track", "--track", track_id, "--state",
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

  def test_exact_description_beats_substring_matches(self):
    self.make_track("auth_1")
    self.write("conductor/tracks/auth_2/spec.md", "# Spec\n")
    self.write("conductor/tracks/auth_2/plan.md", PLAN)
    self.ok("register", "--id", "auth_2", "--description", "Build the CLI v2")
    result = self.ok("status", "--track", "Build the CLI")
    self.assertEqual(result["track"]["id"], "auth_1")
    self.assertIn("ambiguous", self.fails("status", "--track", "build"))

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
    self.assertIn("not completed", self.fails("archive", "--track", track_id))

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
                                          "delegation": "auto",
                                          "isolation": "none"})

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

  # Directory resolution -----------------------------------------------------

  def move_conductor_dir(self, rel):
    target = os.path.join(self.root, rel)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.move(self.cdir, target)
    self.cdir = target

  def test_locate_default_directory(self):
    result = self.ok("locate")
    self.assertEqual(result["conductor_dir"], "conductor")
    self.assertEqual(result["source"], "detected")
    self.assertTrue(result["initialized"])

  def test_locate_detects_agents_directory_and_tracks_work_there(self):
    self.move_conductor_dir(".agents/conductor")
    result = self.ok("locate")
    self.assertEqual(result["conductor_dir"], ".agents/conductor")
    self.write(".agents/conductor/tracks/t1/spec.md", "# Spec\n")
    self.write(".agents/conductor/tracks/t1/plan.md", PLAN)
    self.ok("register", "--id", "t1", "--description", "Hidden")
    self.assertIn("(./tracks/t1/index.md)",
                  self.read(".agents/conductor/tracks.md"))
    self.assertTrue(self.ok("doctor")["healthy"])
    self.assertFalse(os.path.exists(os.path.join(self.root, "conductor")))

  def test_locate_env_and_option_override_detection(self):
    self.move_conductor_dir("docs/ai/conductor")
    self.assertEqual(self.ok("locate")["source"], "default")
    os.environ[state.CONDUCTOR_DIR_ENV] = "docs/ai/conductor"
    result = self.ok("locate")
    self.assertEqual((result["conductor_dir"], result["source"]),
                     ("docs/ai/conductor", "env"))
    result = self.ok("locate", "--conductor-dir", ".conductor")
    self.assertEqual((result["conductor_dir"], result["source"]),
                     (".conductor", "option"))

  def test_locate_warns_about_multiple_initialized_directories(self):
    self.write(".conductor/index.md", INDEX)
    result = self.ok("locate")
    self.assertEqual(result["conductor_dir"], "conductor")
    self.assertIn(".conductor", result["warnings"][0])

  # Track isolation ----------------------------------------------------------

  def git(self, *args, cwd=None):
    return subprocess.run(["git", "-C", cwd or self.root] + list(args),
                          check=True, capture_output=True, text=True).stdout

  def init_git(self):
    self.git("init", "-q", "-b", "main")
    self.git("config", "user.email", "t@example.com")
    self.git("config", "user.name", "Test")
    self.git("add", "-A")
    self.git("commit", "-q", "-m", "init")

  def test_set_meta_records_fields_and_protects_managed_ones(self):
    track_id = self.make_track()
    result = self.ok("set-meta", "--track", track_id, "--field",
                     "base_branch=main", "--field", "note=a=b")
    self.assertEqual(result["metadata"]["base_branch"], "main")
    self.assertEqual(result["metadata"]["note"], "a=b")
    self.assertIn("managed", self.fails("set-meta", "--track", track_id,
                                        "--field", "status=done"))

  def test_branch_info_without_branch(self):
    track_id = self.make_track()
    self.init_git()
    result = self.ok("branch-info", "--track", track_id)
    self.assertEqual(result["branch"], "conductor/" + track_id)
    self.assertFalse(result["branch_exists"])
    self.assertEqual(result["isolation_setting"], "none")
    self.assertEqual(result["current_branch"], "main")
    self.assertEqual(result["default_worktree"], ".worktrees/" + track_id)

  def test_progress_on_track_branch_and_worktree_is_reported(self):
    track_id = self.make_track()
    self.init_git()
    worktree = os.path.join(self.root, ".worktrees", track_id)
    self.git("worktree", "add", "-q", "-b", "conductor/" + track_id, worktree)
    code, _ = self.run_cli_at(worktree, "set-task", "--track", track_id,
                              "--task", "4", "--state", "completed", "--sha",
                              "abcdef1")
    self.assertEqual(code, 0)
    self.run_cli_at(worktree, "set-track", "--track", track_id, "--state",
                    "in_progress")
    self.git("commit", "-q", "-am", "progress", cwd=worktree)

    result = self.ok("tracks", "--branches")
    info = result["tracks"][0]["isolation"]
    self.assertTrue(info["branch_exists"])
    self.assertEqual(os.path.realpath(info["worktree"]),
                     os.path.realpath(worktree))
    self.assertEqual(info["branch_status"], "in_progress")
    self.assertEqual(info["branch_progress"]["completed"], 4)
    # The base branch itself is untouched.
    self.assertEqual(result["tracks"][0]["status"], "pending")
    self.assertEqual(result["tracks"][0]["progress"]["completed"], 3)

  def test_branch_progress_when_project_is_in_a_subdirectory(self):
    track_id = self.make_track()
    self.init_git()
    # Move the whole project into a subdirectory of the repository.
    sub = os.path.join(self.root, "packages", "app")
    os.makedirs(sub)
    self.git("mv", "conductor", "packages/app/conductor")
    self.git("commit", "-q", "-m", "move")
    self.git("switch", "-q", "-c", "conductor/" + track_id)
    self.run_cli_at(sub, "set-track", "--track", track_id, "--state",
                    "in_progress")
    self.git("commit", "-q", "-am", "progress")
    self.git("switch", "-q", "main")
    code, result = self.run_cli_at(sub, "branch-info", "--track", track_id)
    self.assertEqual(code, 0)
    self.assertEqual(result["branch_status"], "in_progress")
    self.assertEqual(result["branch_progress"]["completed"], 3)

  def run_cli_at(self, root, *argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
      code = state.main(list(argv) + ["--root", root])
    return code, json.loads(out.getvalue())

  # Learnings -----------------------------------------------------------------

  def write_learnings(self, track_id, text, base="tracks"):
    return self.write("conductor/%s/%s/learnings.md" % (base, track_id), text)

  def test_remember_requires_track_learnings(self):
    track_id = self.make_track()
    self.assertIn("learnings.md",
                  self.fails("remember", "--track", track_id, "--summary", "x"))

  def test_remember_creates_file_indexes_track_and_links_it(self):
    track_id = self.make_track()
    self.write_learnings(track_id, "# Learnings\n\n## Pitfalls\n- Argparse"
                         " exits on errors; catch SystemExit in tests.\n")
    result = self.ok("remember", "--track", track_id, "--summary",
                     "CLI entry point | parser", "--tags", "CLI, argparse")
    self.assertFalse(result["updated"])
    text = self.read("conductor/learnings.md")
    self.assertIn("## Working Preferences", text)
    self.assertIn("- **%s** (" % track_id, text)
    self.assertIn("CLI entry point / parser | tags: argparse, cli", text)
    self.assertIn("[learnings](./tracks/%s/learnings.md)" % track_id, text)
    self.assertIn("[Project Learnings](./learnings.md)",
                  self.read("conductor/index.md"))
    self.assertIn("[Learnings](./learnings.md)",
                  self.read("conductor/tracks/%s/index.md" % track_id))

    # Remembering again replaces the entry instead of duplicating it.
    result = self.ok("remember", "--track", track_id, "--summary", "Updated")
    self.assertTrue(result["updated"])
    text = self.read("conductor/learnings.md")
    self.assertEqual(text.count("- **%s**" % track_id), 1)
    self.assertIn("Updated", text)

  def test_add_note_appends_once_to_the_right_section(self):
    self.ok("add-note", "--section", "conventions", "--text",
            "Validate inputs at the CLI boundary")
    result = self.ok("add-note", "--section", "conventions", "--text",
                     "validate inputs at the CLI boundary")
    self.assertFalse(result["added"])
    self.ok("add-note", "--section", "preferences", "--text",
            "Keep commits small")
    self.ok("add-note", "--section", "preferences", "--text",
            "**Never** push to main")
    self.assertFalse(self.ok("add-note", "--section", "preferences", "--text",
                             "**Never** push to main")["added"])
    text = self.read("conductor/learnings.md")
    conventions = text.index("## Conventions")
    index = text.index("## Track Index")
    note = text.index("- Validate inputs")
    self.assertTrue(conventions < note < index)
    self.assertLess(text.index("- Keep commits small"), conventions)

  def test_recall_ranks_matches_and_follows_archived_tracks(self):
    cli = self.make_track("cli_1", plan="## P\n- [x] Task: A 1234567\n")
    self.write_learnings(cli, "## Pitfalls\n- Argparse exits on errors.\n")
    self.ok("remember", "--track", cli, "--summary", "Command line parser",
            "--tags", "cli,argparse")
    web = self.make_track("web_2")
    self.write_learnings(web, "## Decisions\n- Flask for the dashboard.\n")
    self.ok("remember", "--track", web, "--summary", "Web dashboard",
            "--tags", "web,flask")
    self.ok("add-note", "--section", "conventions", "--text", "Use pathlib")

    self.ok("set-track", "--track", cli, "--state", "completed")
    self.ok("archive", "--track", cli)
    self.assertIn("[learnings](./archive/cli_1/learnings.md)",
                  self.read("conductor/learnings.md"))

    result = self.ok("recall", "--query", "Add subcommands to the CLI parser")
    self.assertEqual([m["id"] for m in result["matches"]], ["cli_1"])
    self.assertEqual(result["matches"][0]["learnings"],
                     "conductor/archive/cli_1/learnings.md")
    self.assertEqual(result["conventions"], ["Use pathlib"])
    self.assertTrue(self.ok("doctor")["healthy"])

  def test_recall_without_learnings_file(self):
    result = self.ok("recall", "--query", "anything")
    self.assertEqual(result["matches"], [])
    self.assertIsNone(result["learnings_file"])

  def test_doctor_reports_learnings_for_missing_track(self):
    self.write("conductor/learnings.md",
               state.LEARNINGS_TEMPLATE + "- **gone** (2026-01-01): Old |"
               " [learnings](./tracks/gone/learnings.md)\n")
    codes = {w["code"] for w in self.ok("doctor")["warnings"]}
    self.assertIn("missing_learnings", codes)

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
