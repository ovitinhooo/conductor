"""Tests for scripts/validate_mod.py (the staged-copy validation of the mod).

Why the script exists: `claude plugin validate .` on the repo root only checks
`.claude-plugin/marketplace.json` (the marketplace manifest wins) and never
analyses the mod module. The module is analysed only in a directory that has
`.claude-plugin/plugin.json` and no marketplace.json. The repo keeps its plugin
manifest at the root `plugin.json`, so the script validates a staged copy.

Interface pinned by these tests (scripts/validate_mod.py):

  stage(root, dest)
    Copies the tree at `root` into the (new) directory `dest`, excluding `.git`,
    `.worktrees`, `node_modules`, `__pycache__` (at any depth), the generated
    ROOT `tsconfig.json` and `.claude-plugin/types`. Then copies the root
    `plugin.json` to `<dest>/.claude-plugin/plugin.json` and removes
    `<dest>/.claude-plugin/marketplace.json`. Never modifies `root`.

  validate(root, command=("claude",), run=None) -> dict
    Stages into a temporary directory (removed afterwards, also when the run
    fails or the runner raises), then calls
    `run([*command, "plugin", "validate", "."], cwd)` with cwd = the staged
    directory. Never passes --strict (the manifest has an `author` warning).
    `run` is the injectable runner: it receives (argv: list[str], cwd: str) and
    returns either an object with `returncode`, `stdout` and `stderr`
    attributes (subprocess.CompletedProcess-like) or a tuple
    `(returncode, stdout, stderr)`. The default runner uses subprocess with a
    generous timeout. A runner raising OSError (FileNotFoundError included)
    means the command could not be started.
    The returned dict has the keys:
      ok       bool, True only if no problems were found
      problems list[str], human readable, empty when ok
      hooks    the module's `hooks:` output line (stripped) or None
      calls    the module's `calls:` output line (stripped) or None
      output   the command's stdout (str)
    It fails when: the exit code is non-zero (even if the text says passed);
    stdout lacks "Validation passed"; stdout lacks a hooks line; stdout lacks
    a calls line; the command cannot be started (the problem says the command
    was not found and mentions CLAUDE_COMMAND / --command). A hooks (calls)
    line is a line containing `hooks:` (`calls:`) that does not start with
    "Validating", so the `Validating hooks: <path>` header alone is not enough.

  main(argv=None, run=None) -> int
    CLI: `validate_mod.py [--root DIR] [--command "npx -y @anthropic-ai/claude-code"]`.
    The command string is split with shlex; the default is the environment
    variable CLAUDE_COMMAND, else `claude`; --root defaults to the repo root.
    Prints the hooks and calls lines on success (returns 0) and the problems on
    failure (returns 1). `run` is passed through to validate().
"""

import contextlib
import hashlib
import importlib.util
import io
import os
import shutil
import subprocess
import tempfile
import types
import unittest
from unittest import mock

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_SCRIPT = os.path.join(_REPO, "scripts", "validate_mod.py")

GOOD_OUTPUT = """\
Validating plugin manifest: {dir}/.claude-plugin/plugin.json

⚠ Found 1 warning:

  ❯ author: No author information provided. Consider adding author details for plugin attribution

Validating hooks: {dir}/hooks/hooks.json
  ❯ ./register.ts hooks: session.start, command.run{{command=conductor-progress}}, tool.pre
  ❯ ./register.ts calls: $.audio.play (via playSound), $.clock.every (via startRefresh)

✔ Validation passed with warnings
"""

BUGGY_OUTPUT = """\
Validating marketplace manifest: {dir}/.claude-plugin/marketplace.json

✔ Validation passed
"""

HEADER_ONLY_OUTPUT = """\
Validating plugin manifest: {dir}/.claude-plugin/plugin.json
Validating hooks: {dir}/hooks/hooks.json
✔ Validation passed
"""

NO_CALLS_OUTPUT = """\
Validating plugin manifest: {dir}/.claude-plugin/plugin.json
Validating hooks: {dir}/hooks/hooks.json
  ❯ ./register.ts hooks: session.start
✔ Validation passed
"""

NO_HOOKS_OUTPUT = """\
Validating plugin manifest: {dir}/.claude-plugin/plugin.json
Validating hooks: {dir}/hooks/hooks.json
  ❯ ./register.ts calls: $.audio.play (via playSound)
✔ Validation passed
"""

FAILED_OUTPUT = """\
Validating plugin manifest: {dir}/.claude-plugin/plugin.json
  ❯ ./register.ts hooks: session.start
  ❯ ./register.ts calls: $.audio.play (via playSound)
✖ Validation failed
"""


def load_script():
  """Load scripts/validate_mod.py, failing with one clear message."""
  if not os.path.exists(_SCRIPT):
    raise AssertionError(
        "scripts/validate_mod.py does not exist yet (expected in the RED phase)")
  spec = importlib.util.spec_from_file_location("validate_mod", _SCRIPT)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  return module


def write(root, rel, text="x\n"):
  path = os.path.join(root, rel)
  os.makedirs(os.path.dirname(path), exist_ok=True)
  with open(path, "w", encoding="utf-8") as f:
    f.write(text)


def make_fixture(root):
  """A minimal repo tree with everything stage() must keep or drop."""
  write(root, "plugin.json", '{"name": "fixture"}\n')
  write(root, ".claude-plugin/marketplace.json", '{"plugins": []}\n')
  write(root, ".claude-plugin/types/api.d.ts", "declare const a: 1\n")
  write(root, ".claude-plugin/extra.json", "{}\n")
  write(root, "tsconfig.json", "{}\n")
  write(root, "hooks/hooks.json", "{}\n")
  write(root, "hooks/register.ts", "export default () => {}\n")
  write(root, "hooks/tsconfig.json", '{"keep": true}\n')
  write(root, "skills/a/SKILL.md", "# a\n")
  write(root, "scripts/__pycache__/x.pyc", "bytecode")
  write(root, ".git/HEAD", "ref: refs/heads/main\n")
  write(root, ".worktrees/w/file.txt", "wt\n")
  write(root, "node_modules/pkg/index.js", "module.exports = 1\n")


def snapshot(root):
  """Map every path under root to its content hash (None for directories)."""
  result = {}
  for dirpath, dirnames, filenames in os.walk(root):
    for name in dirnames:
      result[os.path.relpath(os.path.join(dirpath, name), root)] = None
    for name in filenames:
      path = os.path.join(dirpath, name)
      with open(path, "rb") as f:
        result[os.path.relpath(path, root)] = hashlib.sha256(f.read()).hexdigest()
  return result


def listing(root):
  return set(snapshot(root))


class Stub:
  """Records the calls of the injected runner and returns a canned result."""

  def __init__(self, stdout="", returncode=0, stderr="", as_tuple=False,
               raises=None):
    self.stdout = stdout
    self.returncode = returncode
    self.stderr = stderr
    self.as_tuple = as_tuple
    self.raises = raises
    self.calls = []
    self.seen = []

  def __call__(self, argv, cwd):
    self.calls.append((list(argv), cwd))
    self.seen.append({
        "plugin": os.path.exists(os.path.join(cwd, ".claude-plugin",
                                              "plugin.json")),
        "marketplace": os.path.exists(os.path.join(cwd, ".claude-plugin",
                                                   "marketplace.json")),
    })
    if self.raises is not None:
      raise self.raises
    stdout = self.stdout.format(dir=cwd)
    if self.as_tuple:
      return (self.returncode, stdout, self.stderr)
    return types.SimpleNamespace(returncode=self.returncode, stdout=stdout,
                                 stderr=self.stderr)


class ScriptCase(unittest.TestCase):
  """Loads the script once so the report shows a single clear reason."""

  @classmethod
  def setUpClass(cls):
    cls.mod = load_script()

  def setUp(self):
    self.root = tempfile.mkdtemp()
    self.addCleanup(shutil.rmtree, self.root, True)
    make_fixture(self.root)


class StageTest(ScriptCase):

  def setUp(self):
    super().setUp()
    self.dest = os.path.join(tempfile.mkdtemp(), "staged")
    self.addCleanup(shutil.rmtree, os.path.dirname(self.dest), True)

  def test_copies_the_tree_without_the_excluded_paths(self):
    self.mod.stage(self.root, self.dest)
    kept = listing(self.dest)
    for rel in ("hooks/hooks.json", "hooks/register.ts", "skills/a/SKILL.md",
                ".claude-plugin/extra.json", "plugin.json"):
      self.assertIn(rel.replace("/", os.sep), kept)
    for rel in (".git", ".worktrees", "node_modules", "tsconfig.json",
                ".claude-plugin/types", "scripts/__pycache__"):
      self.assertNotIn(rel.replace("/", os.sep), kept)
    self.assertFalse([p for p in kept if p.startswith(".git" + os.sep)])

  def test_only_the_root_tsconfig_is_excluded(self):
    self.mod.stage(self.root, self.dest)
    self.assertTrue(os.path.exists(os.path.join(self.dest, "hooks",
                                                "tsconfig.json")))

  def test_root_plugin_json_becomes_the_dot_claude_plugin_manifest(self):
    self.mod.stage(self.root, self.dest)
    staged = os.path.join(self.dest, ".claude-plugin", "plugin.json")
    with open(staged, "rb") as f, open(
        os.path.join(self.root, "plugin.json"), "rb") as g:
      self.assertEqual(f.read(), g.read())

  def test_marketplace_manifest_is_removed_from_the_copy(self):
    self.mod.stage(self.root, self.dest)
    self.assertFalse(os.path.exists(
        os.path.join(self.dest, ".claude-plugin", "marketplace.json")))

  def test_the_original_tree_is_untouched(self):
    before = snapshot(self.root)
    self.mod.stage(self.root, self.dest)
    self.assertEqual(snapshot(self.root), before)
    self.assertTrue(os.path.exists(
        os.path.join(self.root, ".claude-plugin", "marketplace.json")))
    self.assertFalse(os.path.exists(
        os.path.join(self.root, ".claude-plugin", "plugin.json")))


class ValidateTest(ScriptCase):

  def validate(self, stub, **kwargs):
    return self.mod.validate(self.root, run=stub, **kwargs)

  def test_good_run_passes_with_the_author_warning(self):
    result = self.validate(Stub(GOOD_OUTPUT))
    self.assertTrue(result["ok"], result["problems"])
    self.assertEqual(result["problems"], [])
    self.assertIn("hooks: session.start", result["hooks"])
    self.assertIn("calls: $.audio.play", result["calls"])
    self.assertIn("Validation passed", result["output"])

  def test_runner_may_return_a_tuple(self):
    result = self.validate(Stub(GOOD_OUTPUT, as_tuple=True))
    self.assertTrue(result["ok"], result["problems"])

  def test_validation_passed_without_a_hooks_line_fails(self):
    result = self.validate(Stub(BUGGY_OUTPUT))
    self.assertFalse(result["ok"])
    self.assertTrue(any("hooks" in p for p in result["problems"]),
                    result["problems"])
    self.assertIsNone(result["hooks"])

  def test_the_validating_hooks_header_alone_is_not_a_hooks_line(self):
    result = self.validate(Stub(HEADER_ONLY_OUTPUT))
    self.assertFalse(result["ok"])
    self.assertTrue(any("hooks" in p for p in result["problems"]))
    self.assertTrue(any("calls" in p for p in result["problems"]))

  def test_missing_calls_line_fails(self):
    result = self.validate(Stub(NO_CALLS_OUTPUT))
    self.assertFalse(result["ok"])
    self.assertTrue(any("calls" in p for p in result["problems"]))
    self.assertFalse(any("hooks" in p for p in result["problems"]))
    self.assertIsNone(result["calls"])

  def test_missing_hooks_line_with_calls_present_fails(self):
    result = self.validate(Stub(NO_HOOKS_OUTPUT))
    self.assertFalse(result["ok"])
    self.assertTrue(any("hooks" in p for p in result["problems"]))
    self.assertFalse(any("calls" in p for p in result["problems"]))

  def test_missing_validation_passed_fails(self):
    result = self.validate(Stub(FAILED_OUTPUT))
    self.assertFalse(result["ok"])
    self.assertTrue(any("Validation passed" in p for p in result["problems"]))

  def test_nonzero_exit_fails_even_if_the_text_says_passed(self):
    result = self.validate(Stub(GOOD_OUTPUT, returncode=1, stderr="boom"))
    self.assertFalse(result["ok"])
    self.assertTrue(any("exit" in p.lower() or "status" in p.lower()
                        for p in result["problems"]), result["problems"])

  def test_command_not_found_is_reported_with_the_remedy(self):
    result = self.validate(Stub(raises=FileNotFoundError("claude")))
    self.assertFalse(result["ok"])
    text = " ".join(result["problems"])
    self.assertIn("not found", text)
    self.assertIn("CLAUDE_COMMAND", text)
    self.assertIn("--command", text)

  def test_other_oserror_means_the_command_could_not_start(self):
    result = self.validate(Stub(raises=PermissionError("denied")))
    self.assertFalse(result["ok"])
    self.assertTrue(result["problems"])

  def test_runs_the_plain_validate_command_in_the_staged_dir(self):
    stub = Stub(GOOD_OUTPUT)
    self.validate(stub)
    self.assertEqual(len(stub.calls), 1)
    argv, cwd = stub.calls[0]
    self.assertEqual(argv, ["claude", "plugin", "validate", "."])
    self.assertNotIn("--strict", argv)
    self.assertNotEqual(os.path.realpath(cwd), os.path.realpath(self.root))
    self.assertEqual(stub.seen[0], {"plugin": True, "marketplace": False})

  def test_a_custom_command_is_prefixed_to_the_arguments(self):
    stub = Stub(GOOD_OUTPUT)
    self.validate(stub, command=("npx", "-y", "@anthropic-ai/claude-code"))
    self.assertEqual(stub.calls[0][0], [
        "npx", "-y", "@anthropic-ai/claude-code", "plugin", "validate", "."])

  def test_the_staged_dir_is_removed_after_success_and_failure(self):
    for stub in (Stub(GOOD_OUTPUT), Stub(BUGGY_OUTPUT, returncode=2),
                 Stub(raises=FileNotFoundError("claude"))):
      self.validate(stub)
      cwd = stub.calls[0][1]
      self.assertFalse(os.path.exists(cwd), cwd)

  def test_the_staged_dir_is_removed_when_the_runner_crashes(self):
    stub = Stub(raises=RuntimeError("crash"))
    with self.assertRaises(RuntimeError):
      self.validate(stub)
    self.assertFalse(os.path.exists(stub.calls[0][1]))

  def test_the_original_tree_is_untouched(self):
    before = snapshot(self.root)
    self.validate(Stub(GOOD_OUTPUT))
    self.assertEqual(snapshot(self.root), before)

  def test_the_default_runner_reports_a_missing_command(self):
    result = self.mod.validate(
        self.root, command=("definitely-not-a-real-command-xyz",))
    self.assertFalse(result["ok"])
    self.assertIn("not found", " ".join(result["problems"]))


class MainTest(ScriptCase):

  def run_main(self, argv, stub, env=None):
    out, err = io.StringIO(), io.StringIO()
    environ = {k: v for k, v in os.environ.items() if k != "CLAUDE_COMMAND"}
    environ.update(env or {})
    with mock.patch.dict(os.environ, environ, clear=True), \
        contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
      code = self.mod.main(argv, run=stub)
    return code, out.getvalue(), err.getvalue()

  def test_success_prints_the_hooks_and_calls_lines(self):
    stub = Stub(GOOD_OUTPUT)
    code, out, _ = self.run_main(["--root", self.root], stub)
    self.assertEqual(code, 0)
    self.assertIn("hooks: session.start", out)
    self.assertIn("calls: $.audio.play", out)

  def test_failure_returns_one_and_prints_the_problems(self):
    code, out, err = self.run_main(["--root", self.root], Stub(BUGGY_OUTPUT))
    self.assertEqual(code, 1)
    self.assertIn("hooks", out + err)

  def test_default_command_is_claude(self):
    stub = Stub(GOOD_OUTPUT)
    self.run_main(["--root", self.root], stub)
    self.assertEqual(stub.calls[0][0], ["claude", "plugin", "validate", "."])

  def test_command_option_is_split_with_shlex(self):
    stub = Stub(GOOD_OUTPUT)
    self.run_main(["--root", self.root, "--command",
                   "npx -y '@anthropic-ai/claude-code'"], stub)
    self.assertEqual(stub.calls[0][0], [
        "npx", "-y", "@anthropic-ai/claude-code", "plugin", "validate", "."])

  def test_claude_command_env_var_is_the_default(self):
    stub = Stub(GOOD_OUTPUT)
    self.run_main(["--root", self.root], stub,
                  env={"CLAUDE_COMMAND": "npx -y claude-code"})
    self.assertEqual(stub.calls[0][0], [
        "npx", "-y", "claude-code", "plugin", "validate", "."])

  def test_command_option_beats_the_env_var(self):
    stub = Stub(GOOD_OUTPUT)
    self.run_main(["--root", self.root, "--command", "mine"], stub,
                  env={"CLAUDE_COMMAND": "other"})
    self.assertEqual(stub.calls[0][0][0], "mine")

  def test_missing_command_returns_one(self):
    code, out, err = self.run_main(
        ["--root", self.root], Stub(raises=FileNotFoundError("claude")))
    self.assertEqual(code, 1)
    self.assertIn("not found", out + err)


class RealRepoTest(ScriptCase):

  def setUp(self):
    self.dest = os.path.join(tempfile.mkdtemp(), "staged")
    self.addCleanup(shutil.rmtree, os.path.dirname(self.dest), True)

  def test_staging_the_real_repo_is_small_and_complete(self):
    before = os.path.exists(os.path.join(_REPO, ".claude-plugin",
                                         "plugin.json"))
    self.mod.stage(_REPO, self.dest)
    claude = os.path.join(self.dest, ".claude-plugin")
    for rel in ("hooks/hooks.json", "hooks/register.ts"):
      self.assertTrue(os.path.isfile(os.path.join(self.dest, rel)), rel)
    with open(os.path.join(claude, "plugin.json"), "rb") as f, open(
        os.path.join(_REPO, "plugin.json"), "rb") as g:
      self.assertEqual(f.read(), g.read())
    self.assertFalse(os.path.exists(os.path.join(claude, "marketplace.json")))
    self.assertFalse(os.path.exists(os.path.join(claude, "types")))
    self.assertFalse(os.path.exists(os.path.join(self.dest, ".git")))
    self.assertFalse(os.path.exists(os.path.join(self.dest, "tsconfig.json")))
    names = {n for _, dirs, files in os.walk(self.dest) for n in dirs + files}
    self.assertFalse(names & {".git", ".worktrees", "node_modules",
                              "__pycache__"})
    size = sum(os.path.getsize(os.path.join(d, f))
               for d, _, files in os.walk(self.dest) for f in files)
    self.assertLess(size, 5 * 1024 * 1024)
    # The source tree gained no .claude-plugin/plugin.json.
    self.assertEqual(
        os.path.exists(os.path.join(_REPO, ".claude-plugin", "plugin.json")),
        before)
    self.assertTrue(os.path.exists(
        os.path.join(_REPO, ".claude-plugin", "marketplace.json")))

  def test_every_tracked_file_is_staged(self):
    try:
      tracked = subprocess.run(
          ["git", "-C", _REPO, "ls-files", "-z"], capture_output=True,
          check=True).stdout.decode().split("\0")
    except (OSError, subprocess.CalledProcessError):
      self.skipTest("git is not available")
    self.mod.stage(_REPO, self.dest)
    skipped = {".claude-plugin/marketplace.json"}
    for rel in filter(None, tracked):
      if rel in skipped or not os.path.exists(os.path.join(_REPO, rel)):
        continue
      self.assertTrue(os.path.exists(os.path.join(self.dest, rel)), rel)


if __name__ == "__main__":
  unittest.main()
