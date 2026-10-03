"""Static checks for Conductor's skills, agents, and manifests.

The skills are prompts, so most regressions are invisible until an agent trips
over them. This linter catches the mechanical ones: broken frontmatter,
unbalanced or collapsed code blocks, references to files, skills, agents, or
state tool flags that do not exist, drift between duplicated assets, and
version mismatches between manifests. It also validates the progress mod's
manifest files: hooks/hooks.json must be valid JSON naming exactly one module
file that exists inside the plugin and has a supported extension, and the file
named by the `types` field of plugin.json, if any, must exist.

Usage:
  python3 scripts/lint_skills.py [--root <repo_root>]

Exits with status 1 and prints one line per problem if anything is wrong.
"""

import argparse
import filecmp
import importlib.util
import json
import os
import re
import sys

FRONTMATTER_RE = re.compile(r"\A---\r?\n(?P<body>.*?)\r?\n---\r?\n", re.S)
FIELD_RE = re.compile(r"^(?P<key>[A-Za-z_][\w-]*):\s*(?P<value>.*)$", re.M)
FENCE_RE = re.compile(r"^\s*(```|~~~)")
# An inline code span that starts with a language tag is a fenced block that
# was collapsed onto one line, which agents then execute literally.
COLLAPSED_BLOCK_RE = re.compile(
    r"(?<!`)`(?:bash|sh|shell|markdown|json|python|yaml)\s+[^`\n]*[^`\s][^`\n]*`"
    r"(?!`)"
)
INLINE_CODE_RE = re.compile(r"(?<!`)`([^`\n]+)`(?!`)")
SKILL_REF_RE = re.compile(r"`(conductor-[a-z-]+)`")
LOCAL_FILE_RE = re.compile(
    r"(?:<skill_dir>/)?(?<![\w/.<>-])((?:assets|scripts)/[\w./-]*\w)"
)
PLUGIN_FILE_RE = re.compile(r"<plugin_root>/([\w./-]*\w)")
STATE_CALL_RE = re.compile(r"^(?P<cmd>[a-z][a-z-]*)(?P<rest>(?:\s+--?\S.*)?)$")
FLAG_RE = re.compile(r"(?<!\S)(--?[a-z][a-z-]*)")
STALE_PATTERNS = {
    "~/.agents/extensions": "Gemini CLI extension path; skills now ship as a"
                            " plugin",
    "commands/conductor/": "TOML commands were replaced by skills",
}
DUPLICATED_ASSETS = [
    ("skills/conductor-setup/assets/catalog.md",
     "skills/conductor-new-track/assets/catalog.md"),
]
KNOWN_AGENTS_DIR = "agents"
HOOKS_MANIFEST = "hooks/hooks.json"
MOD_MODULE_EXTENSIONS = (".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts",
                         ".tsx")


def _frontmatter(text):
  match = FRONTMATTER_RE.match(text)
  if not match:
    return None
  return {m.group("key"): m.group("value").strip()
          for m in FIELD_RE.finditer(match.group("body"))}


def _load_state_parser(root):
  path = os.path.join(root, "scripts", "conductor_state.py")
  if not os.path.isfile(path):
    return None
  spec = importlib.util.spec_from_file_location("conductor_state", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  parser = module.build_parser()
  commands = {}
  for action in parser._actions:  # pylint: disable=protected-access
    if hasattr(action, "choices") and isinstance(action.choices, dict):
      for name, sub in action.choices.items():
        flags = set()
        for sub_action in sub._actions:  # pylint: disable=protected-access
          flags.update(sub_action.option_strings)
        commands[name] = flags
  return commands


def check_markdown(path, text, problems, rel):
  """Checks fences and collapsed code blocks in one Markdown file."""
  fences = 0
  in_fence = False
  for lineno, line in enumerate(text.splitlines(), start=1):
    if FENCE_RE.match(line):
      fences += 1
      in_fence = not in_fence
      continue
    if in_fence:
      continue
    for match in COLLAPSED_BLOCK_RE.finditer(line):
      problems.append(
          "%s:%d: code block collapsed into inline code: %s"
          % (rel, lineno, match.group(0)[:60])
      )
  if fences % 2:
    problems.append("%s: unbalanced code fences (%d fence lines)"
                    % (rel, fences))
  del path


def check_references(root, skill_dir, text, rel, problems, skills, agents,
                     state_commands):
  """Checks file, skill, agent, and state tool references in a document."""
  for lineno, line in enumerate(text.splitlines(), start=1):
    for match in LOCAL_FILE_RE.finditer(line):
      target = match.group(1)
      base = skill_dir if skill_dir else root
      if not os.path.exists(os.path.join(base, target)) and not (
          os.path.exists(os.path.join(root, target))):
        problems.append("%s:%d: references missing file '%s'"
                        % (rel, lineno, target))
    for match in PLUGIN_FILE_RE.finditer(line):
      if not os.path.exists(os.path.join(root, match.group(1))):
        problems.append("%s:%d: references missing plugin file '%s'"
                        % (rel, lineno, match.group(1)))
    for match in SKILL_REF_RE.finditer(line):
      name = match.group(1)
      if name not in skills and name not in agents:
        problems.append("%s:%d: references unknown skill or agent '%s'"
                        % (rel, lineno, name))
    for pattern, reason in STALE_PATTERNS.items():
      if pattern in line:
        problems.append("%s:%d: stale reference '%s' (%s)"
                        % (rel, lineno, pattern, reason))
    if state_commands:
      for span in INLINE_CODE_RE.findall(line):
        call = STATE_CALL_RE.match(span.strip())
        if not call or call.group("cmd") not in state_commands:
          continue
        allowed = state_commands[call.group("cmd")]
        for flag in FLAG_RE.findall(call.group("rest")):
          if flag not in allowed:
            problems.append(
                "%s:%d: state tool command '%s' has no option '%s'"
                % (rel, lineno, call.group("cmd"), flag)
            )


def _load_json(root, rel, problems):
  """Returns the parsed JSON file, or None (after reporting) if it is bad."""
  try:
    with open(os.path.join(root, rel), encoding="utf-8") as f:
      return json.load(f)
  except ValueError as e:
    problems.append("%s: invalid JSON: %s" % (rel, e))
    return None


def check_mod_manifest(root, problems):
  """Checks hooks/hooks.json and the plugin.json `types` file, if present."""
  if not os.path.isfile(os.path.join(root, HOOKS_MANIFEST)):
    return
  data = _load_json(root, HOOKS_MANIFEST, problems)
  if data is None:
    return
  modules = data.get("modules") if isinstance(data, dict) else None
  if (not isinstance(modules, list) or len(modules) != 1
      or not isinstance(modules[0], str)):
    problems.append(
        '%s: "modules" must be a list of exactly one module path string'
        % HOOKS_MANIFEST
    )
    return
  module = modules[0]
  hooks_dir = os.path.join(root, os.path.dirname(HOOKS_MANIFEST))
  target = os.path.realpath(os.path.join(hooks_dir, module))
  plugin_root = os.path.realpath(root)
  if os.path.commonpath([plugin_root, target]) != plugin_root:
    problems.append("%s: module '%s' is outside the plugin directory"
                    % (HOOKS_MANIFEST, module))
  elif not os.path.isfile(target):
    problems.append("%s: module file '%s' does not exist"
                    % (HOOKS_MANIFEST, module))
  ext = os.path.splitext(module)[1]
  if ext not in MOD_MODULE_EXTENSIONS:
    problems.append("%s: module '%s' has unsupported extension '%s'; use one"
                    " of %s" % (HOOKS_MANIFEST, module, ext,
                                ", ".join(MOD_MODULE_EXTENSIONS)))


def check_types_file(root, problems):
  """Checks that the file named by plugin.json `types` exists."""
  if not os.path.isfile(os.path.join(root, "plugin.json")):
    return
  # Invalid JSON is reported by the version check, so discard it here.
  data = _load_json(root, "plugin.json", [])
  types = data.get("types") if isinstance(data, dict) else None
  if types is not None and not (
      isinstance(types, str) and os.path.isfile(os.path.join(root, types))):
    problems.append("plugin.json: 'types' file '%s' does not exist" % types)


def lint(root):
  problems = []
  skills_root = os.path.join(root, "skills")
  skills = sorted(
      d for d in os.listdir(skills_root)
      if os.path.isfile(os.path.join(skills_root, d, "SKILL.md"))
  ) if os.path.isdir(skills_root) else []
  agents_root = os.path.join(root, KNOWN_AGENTS_DIR)
  agents = sorted(
      f[:-3] for f in os.listdir(agents_root) if f.endswith(".md")
  ) if os.path.isdir(agents_root) else []
  state_commands = _load_state_parser(root)

  documents = []
  for name in skills:
    documents.append((os.path.join(skills_root, name, "SKILL.md"), name,
                      os.path.join(skills_root, name)))
  for name in agents:
    documents.append((os.path.join(agents_root, name + ".md"), name, None))

  for path, name, skill_dir in documents:
    rel = os.path.relpath(path, root)
    with open(path, encoding="utf-8") as f:
      text = f.read()
    meta = _frontmatter(text)
    if meta is None:
      problems.append("%s: missing YAML frontmatter" % rel)
    else:
      if meta.get("name") != name:
        problems.append("%s: frontmatter name '%s' does not match '%s'"
                        % (rel, meta.get("name"), name))
      if not meta.get("description"):
        problems.append("%s: frontmatter has no description" % rel)
    check_markdown(path, text, problems, rel)
    check_references(root, skill_dir, text, rel, problems, skills, agents,
                     state_commands)

  for first, second in DUPLICATED_ASSETS:
    a, b = os.path.join(root, first), os.path.join(root, second)
    if os.path.isfile(a) and os.path.isfile(b):
      if not filecmp.cmp(a, b, shallow=False):
        problems.append("%s and %s must be identical; copy one over the other"
                        % (first, second))
    else:
      problems.append("duplicated asset missing: %s or %s" % (first, second))

  catalog = os.path.join(root, DUPLICATED_ASSETS[0][0])
  if os.path.isfile(catalog):
    with open(catalog, encoding="utf-8") as f:
      for lineno, line in enumerate(f, start=1):
        for url in re.findall(r"https?://\S+", line):
          if not url.endswith("/SKILL.md"):
            problems.append(
                "%s:%d: catalog URL must point to a SKILL.md file: %s"
                % (DUPLICATED_ASSETS[0][0], lineno, url)
            )

  version_path = os.path.join(root, "VERSION")
  version = None
  if os.path.isfile(version_path):
    with open(version_path, encoding="utf-8") as f:
      version = f.read().strip()
  for manifest in ("plugin.json", ".claude-plugin/marketplace.json"):
    path = os.path.join(root, manifest)
    if not os.path.isfile(path):
      continue
    try:
      with open(path, encoding="utf-8") as f:
        data = json.load(f)
    except ValueError as e:
      problems.append("%s: invalid JSON: %s" % (manifest, e))
      continue
    if manifest == "plugin.json" and data.get("version") != version:
      problems.append("plugin.json version '%s' does not match VERSION '%s'"
                      % (data.get("version"), version))
    if manifest.endswith("marketplace.json"):
      for entry in data.get("plugins", []):
        if "version" in entry:
          problems.append(
              "marketplace.json: do not set 'version' on plugin entries;"
              " Claude Code would pin users to it until it changes"
          )
  check_mod_manifest(root, problems)
  check_types_file(root, problems)
  return problems


def main(argv=None):
  parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
  parser.add_argument(
      "--root",
      default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
  )
  args = parser.parse_args(argv)
  problems = lint(os.path.abspath(args.root))
  for problem in problems:
    print(problem)
  if problems:
    print("\n%d problem(s) found." % len(problems))
    return 1
  print("All skill checks passed.")
  return 0


if __name__ == "__main__":
  sys.exit(main())
