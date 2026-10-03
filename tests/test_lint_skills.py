"""Tests for scripts/lint_skills.py."""

import importlib.util
import json
import os
import shutil
import tempfile
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "lint_skills", os.path.join(_REPO, "scripts", "lint_skills.py")
)
lint_skills = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lint_skills)


class LintSkillsTest(unittest.TestCase):

  def setUp(self):
    self.root = tempfile.mkdtemp()
    self.addCleanup(shutil.rmtree, self.root)
    for name in ("skills", "agents", "scripts", ".claude-plugin"):
      shutil.copytree(os.path.join(_REPO, name), os.path.join(self.root, name))
    for name in ("VERSION", "plugin.json"):
      shutil.copy(os.path.join(_REPO, name), self.root)

  def append(self, rel, text):
    with open(os.path.join(self.root, rel), "a", encoding="utf-8") as f:
      f.write(text)

  def problems(self):
    return lint_skills.lint(self.root)

  def test_repository_passes(self):
    self.assertEqual(lint_skills.lint(_REPO), [])

  def test_collapsed_code_block(self):
    self.append("skills/conductor-status/SKILL.md",
                "\nRun `bash mkdir -p x curl -o y`.\n")
    self.assertTrue(any("collapsed" in p for p in self.problems()))

  def test_unbalanced_fence(self):
    self.append("skills/conductor-status/SKILL.md", "\n```bash\necho hi\n")
    self.assertTrue(any("unbalanced" in p for p in self.problems()))

  def test_unknown_state_tool_option(self):
    self.append("skills/conductor-status/SKILL.md",
                "\nRun `set-task --track x --done`.\n")
    self.assertTrue(any("has no option '--done'" in p
                        for p in self.problems()))

  def test_missing_asset_and_unknown_skill(self):
    self.append("skills/conductor-status/SKILL.md",
                "\nRead `assets/missing.md`, then use `conductor-deploy`.\n")
    problems = self.problems()
    self.assertTrue(any("missing file 'assets/missing.md'" in p
                        for p in problems))
    self.assertTrue(any("'conductor-deploy'" in p for p in problems))

  def test_frontmatter_name_mismatch(self):
    path = os.path.join(self.root, "skills/conductor-status/SKILL.md")
    with open(path, encoding="utf-8") as f:
      text = f.read()
    with open(path, "w", encoding="utf-8") as f:
      f.write(text.replace("name: conductor-status", "name: status", 1))
    self.assertTrue(any("does not match" in p for p in self.problems()))

  def test_catalog_drift_and_version_mismatch(self):
    self.append("skills/conductor-new-track/assets/catalog.md", "\nextra\n")
    with open(os.path.join(self.root, "VERSION"), "w") as f:
      f.write("9.9.9\n")
    problems = self.problems()
    self.assertTrue(any("must be identical" in p for p in problems))
    self.assertTrue(any("does not match VERSION" in p for p in problems))

  # Mod manifest checks: hooks/hooks.json (the progress mod) and the
  # plugin.json `types` field.

  def write(self, rel, text=""):
    path = os.path.join(self.root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
      f.write(text)
    return path

  def write_hooks(self, data):
    self.write("hooks/hooks.json",
               data if isinstance(data, str) else json.dumps(data))

  def hooks_problems(self):
    return [p for p in self.problems() if "hooks/hooks.json" in p]

  def assert_one_module_problem(self):
    found = self.hooks_problems()
    self.assertTrue(found, "no problem reported for hooks/hooks.json")
    self.assertTrue(any("exactly one" in p for p in found), found)

  def valid_mod(self, module="./register.ts"):
    self.write("hooks/register.ts", "export default {};\n")
    self.write_hooks({"description": "mod", "modules": [module]})

  def set_types(self, value):
    path = os.path.join(self.root, "plugin.json")
    with open(path, encoding="utf-8") as f:
      data = json.load(f)
    data["types"] = value
    with open(path, "w", encoding="utf-8") as f:
      json.dump(data, f)

  def test_no_hooks_json_is_valid(self):
    self.assertEqual(self.problems(), [])

  def test_valid_mod_layout_passes(self):
    self.valid_mod()
    self.assertEqual(self.problems(), [])

  def test_valid_mod_with_types_file_passes(self):
    self.valid_mod()
    self.write("types/index.d.ts", "export {};\n")
    self.set_types("./types/index.d.ts")
    self.assertEqual(self.problems(), [])

  def test_invalid_json_is_reported_with_file_name(self):
    self.write_hooks("{not json")
    self.assertTrue(any("hooks/hooks.json" in p and "invalid JSON" in p
                        for p in self.problems()))

  def test_missing_modules_key(self):
    self.write_hooks({"description": "mod"})
    self.assert_one_module_problem()

  def test_empty_modules_list(self):
    self.write_hooks({"modules": []})
    self.assert_one_module_problem()

  def test_more_than_one_module(self):
    self.write("hooks/a.ts")
    self.write("hooks/b.ts")
    self.write_hooks({"modules": ["./a.ts", "./b.ts"]})
    self.assert_one_module_problem()

  def test_modules_not_a_list(self):
    self.write("hooks/register.ts")
    self.write_hooks({"modules": "./register.ts"})
    self.assert_one_module_problem()

  def test_module_entry_not_a_string(self):
    self.write_hooks({"modules": [42]})
    self.assert_one_module_problem()

  def test_missing_module_file_is_reported_by_name(self):
    self.write_hooks({"modules": ["./missing.ts"]})
    self.assertTrue(any("missing.ts" in p for p in self.hooks_problems()),
                    self.hooks_problems())

  def test_module_escaping_plugin_root_is_reported(self):
    outside = os.path.join(os.path.dirname(self.root),
                           os.path.basename(self.root) + "-outside.ts")
    self.write(os.path.relpath(outside, self.root), "export {};\n")
    self.addCleanup(os.remove, outside)
    self.write_hooks({"modules": ["../../" + os.path.basename(outside)]})
    self.assertTrue(self.hooks_problems())

  def test_unsupported_module_extension_is_reported(self):
    self.write("hooks/register.txt", "x\n")
    self.write_hooks({"modules": ["./register.txt"]})
    self.assertTrue(any(".txt" in p for p in self.hooks_problems()),
                    self.hooks_problems())

  def test_every_supported_module_extension_passes(self):
    for ext in (".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"):
      with self.subTest(ext=ext):
        self.write("hooks/mod" + ext, "x\n")
        self.write_hooks({"modules": ["./mod" + ext]})
        self.assertEqual(self.problems(), [])

  def test_missing_types_file_is_reported(self):
    self.set_types("./types/missing.d.ts")
    self.assertTrue(any("types" in p and "missing.d.ts" in p
                        for p in self.problems()), self.problems())

  def test_no_types_field_reports_nothing(self):
    self.valid_mod()
    self.assertFalse(any("types" in p for p in self.problems()))


if __name__ == "__main__":
  unittest.main()
