"""Tests for scripts/lint_skills.py."""

import importlib.util
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


if __name__ == "__main__":
  unittest.main()
