"""Validate the progress mod through a staged copy of the plugin.

`claude plugin validate .` on the repo root only checks
`.claude-plugin/marketplace.json` (the marketplace manifest wins) and never
analyses the mod module. The module is analysed only in a directory that has
`.claude-plugin/plugin.json` and no marketplace.json. The repo keeps its plugin
manifest at the root `plugin.json`, so this script copies the repo to a
temporary directory, places `plugin.json` at `.claude-plugin/plugin.json`,
drops the marketplace manifest, runs `plugin validate` there, and requires the
validator's `hooks:` and `calls:` lines. A run that passes without them
validated the wrong thing and fails. `--strict` is never passed: the manifest
has an `author` warning.

Usage:
  python3 scripts/validate_mod.py [--root <repo_root>]
                                  [--command "npx -y @anthropic-ai/claude-code"]

The command defaults to the CLAUDE_COMMAND environment variable, else `claude`.
Exits with status 1 and prints the problems if validation fails.
"""

import argparse
import os
import shlex
import shutil
import subprocess
import sys
import tempfile

DEFAULT_COMMAND = ("claude",)
TIMEOUT_SECONDS = 300
EXCLUDED_NAMES = {".git", ".worktrees", "node_modules", "__pycache__"}
MANIFEST_DIR = ".claude-plugin"


def stage(root, dest):
  """Copy the tree at `root` into the new directory `dest` as a plugin."""
  root = os.path.abspath(root)
  generated = {
      os.path.join(root, "tsconfig.json"),
      os.path.join(root, MANIFEST_DIR, "types"),
  }

  def ignore(directory, names):
    return [name for name in names
            if name in EXCLUDED_NAMES
            or os.path.join(directory, name) in generated]

  shutil.copytree(root, dest, ignore=ignore, symlinks=True)
  manifest_dir = os.path.join(dest, MANIFEST_DIR)
  os.makedirs(manifest_dir, exist_ok=True)
  shutil.copyfile(os.path.join(root, "plugin.json"),
                  os.path.join(manifest_dir, "plugin.json"))
  marketplace = os.path.join(manifest_dir, "marketplace.json")
  if os.path.exists(marketplace):
    os.remove(marketplace)


def _run(argv, cwd):
  return subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL,
                        capture_output=True, text=True, encoding="utf-8",
                        errors="replace", timeout=TIMEOUT_SECONDS, check=False)


def _result(raw):
  if isinstance(raw, tuple):
    return raw
  return raw.returncode, raw.stdout, raw.stderr


def _find_line(output, key):
  """Return the first `key:` output line that is not a `Validating` header."""
  for line in output.splitlines():
    line = line.strip()
    if key in line and not line.startswith("Validating"):
      return line
  return None


def _outcome(returncode, stdout, stderr, result):
  """Check the validator's output and record the problems on `result`."""
  problems = result["problems"]
  if returncode != 0:
    detail = (stderr or "").strip() or stdout.strip()
    problems.append("the validator exited with status %s%s"
                    % (returncode, ": " + detail if detail else ""))
  if "Validation passed" not in stdout:
    problems.append("the output lacks 'Validation passed'")
  result["hooks"] = _find_line(stdout, "hooks:")
  result["calls"] = _find_line(stdout, "calls:")
  if result["hooks"] is None:
    problems.append("the output has no 'hooks:' line: the mod module was not"
                    " analysed")
  if result["calls"] is None:
    problems.append("the output has no 'calls:' line: the mod module was not"
                    " analysed")


def validate(root, command=DEFAULT_COMMAND, run=None):
  """Validate the plugin at `root` in a staged copy; return a result dict."""
  run = run or _run
  result = {"ok": False, "problems": [], "hooks": None, "calls": None,
            "output": ""}
  problems = result["problems"]
  if not os.path.isfile(os.path.join(root, "plugin.json")):
    problems.append("plugin.json not found in %s" % root)
    return result
  argv = [*command, "plugin", "validate", "."]
  temp = tempfile.mkdtemp(prefix="validate-mod-")
  try:
    staged = os.path.join(temp, "plugin")
    stage(root, staged)
    try:
      returncode, stdout, stderr = _result(run(argv, staged))
    except FileNotFoundError:
      problems.append("command not found: %s; set CLAUDE_COMMAND or --command"
                      % shlex.join(command))
    except OSError as error:
      problems.append("could not start %s (%s); set CLAUDE_COMMAND or"
                      " --command" % (shlex.join(command), error))
    except subprocess.TimeoutExpired:
      problems.append("the validator did not finish within %d seconds"
                      % TIMEOUT_SECONDS)
    else:
      result["output"] = stdout or ""
      _outcome(returncode, result["output"], stderr, result)
  finally:
    shutil.rmtree(temp, ignore_errors=True)
  result["ok"] = not problems
  return result


def main(argv=None, run=None):
  parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
  parser.add_argument(
      "--root",
      default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
  )
  parser.add_argument(
      "--command",
      default=os.environ.get("CLAUDE_COMMAND") or " ".join(DEFAULT_COMMAND),
      help="how to start Claude Code (default: $CLAUDE_COMMAND, else claude)",
  )
  args = parser.parse_args(argv)
  result = validate(os.path.abspath(args.root), shlex.split(args.command),
                    run=run)
  if result["ok"]:
    print(result["hooks"])
    print(result["calls"])
    print("The mod module validated.")
    return 0
  for problem in result["problems"]:
    print(problem)
  print("\n%d problem(s) found." % len(result["problems"]))
  return 1


if __name__ == "__main__":
  sys.exit(main())
