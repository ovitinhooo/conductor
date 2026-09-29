"""Determines the next unblocked setup step in the Conductor workflow."""

import json
import os
import sys


def determine_resumption(project_root=".", conductor_dir="conductor"):
  """Checks existing setup artifacts and returns the next unblocked step.

  Args:
    project_root: The project root that contains (or will contain) the
      Conductor directory. Paths are resolved against it rather than the
      current working directory, so the script gives the same answer no matter
      where it is invoked from.
    conductor_dir: The Conductor directory, relative to the project root.
  """
  conductor_dir = os.path.join(project_root, conductor_dir)
  files = [
      "product.md",
      "product-guidelines.md",
      "tech-stack.md",
      "code_styleguides",
      "workflow.md",
  ]

  checklist = {}
  for filename in files:
    path = os.path.join(conductor_dir, filename)
    checklist[filename] = os.path.exists(path)

  setup_complete = os.path.exists(os.path.join(conductor_dir, "index.md"))

  next_step = None

  chain = [
      ("product.md", "Product Definition"),
      ("product-guidelines.md", "Product Guidelines"),
      ("tech-stack.md", "Technology Stack"),
      ("code_styleguides", "Code Style Guides"),
      ("workflow.md", "Workflow Configuration"),
  ]

  for filename, step_name in chain:
    if not checklist[filename]:
      next_step = {
          "step": step_name,
          "file": filename,
      }
      break

  return {
      "setup_complete": setup_complete,
      "checklist": checklist,
      "next_step": next_step,
  }


if __name__ == "__main__":
  root = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
  directory = sys.argv[2] if len(sys.argv) > 2 else "conductor"
  result = determine_resumption(root, directory)
  print(json.dumps(result, indent=2))
  sys.exit(0)
