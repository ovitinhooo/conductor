"""Deterministic reads and updates of Conductor's project state.

Conductor's state lives in plain Markdown/JSON files (the tracks registry, each
track's plan and metadata). Parsing and editing them by hand is error prone for
an agent: markers get lost, SHAs are appended in the wrong place, and completed
tracks end up in inconsistent states. This script performs those operations the
same way every time and reports the result as JSON on stdout.

It only touches files. It never runs VCS commands, so committing stays with the
calling skill.

Usage:
  python3 conductor_state.py <command> [options] --root <project_root>

Commands:
  locate           Resolve which directory holds Conductor's files.
  doctor           Check the Conductor directory for missing or inconsistent
                   state.
  tracks           List tracks in the registry with their progress.
  status           Summarize progress for one track or for the whole project.
  next-task        Return the task to work on next (resumes an in-progress
                   task first).
  set-task         Change a task's status marker and optionally record a SHA.
  set-checkpoint   Record a phase checkpoint SHA on a phase heading.
  set-track        Change a track's status in the registry and metadata.
  settings         Read execution settings from workflow.md (with defaults).
  new-id           Generate a unique track id from a short name.
  register         Create a track's metadata/index files and registry entry.
  archive          Move a track to the archive and remove it from the registry.
  touch            Refresh a track's `updated_at` timestamp.

Exit codes: 0 on success, 1 on a reported error, 2 on invalid usage.
"""

import argparse
import datetime
import json
import os
import re
import shutil
import sys

DEFAULT_CONDUCTOR_DIR = "conductor"
# Locations probed, in order, for an initialized Conductor directory. A custom
# location outside this list can be set with the CONDUCTOR_DIR environment
# variable or the --conductor-dir option.
CANDIDATE_DIRS = ("conductor", ".conductor", ".agents/conductor")
CONDUCTOR_DIR_ENV = "CONDUCTOR_DIR"
CORE_FILES = {
    "product.md": "Product Definition",
    "product-guidelines.md": "Product Guidelines",
    "tech-stack.md": "Tech Stack",
    "workflow.md": "Workflow",
}
REQUIRED_CORE_FILES = ("product.md", "tech-stack.md", "workflow.md")
REGISTRY_HEADER = (
    "# Project Tracks\n\n"
    "This file tracks all major tracks for the project. Each track has its own"
    " detailed plan in its respective folder.\n"
)

MARK_TO_STATUS = {
    " ": "pending",
    "~": "in_progress",
    "x": "completed",
    "X": "completed",
}
STATUS_TO_MARK = {"pending": " ", "in_progress": "~", "completed": "x"}
# The registry uses pending/in_progress/completed; metadata.json historically
# uses "new" for a track that has not started yet.
REGISTRY_TO_METADATA_STATUS = {
    "pending": "new",
    "in_progress": "in_progress",
    "completed": "completed",
}

TRACK_LINE_RE = re.compile(
    r"^(?P<prefix>\s*(?:[-*]\s+|#{1,6}\s+))\[(?P<mark>[ xX~])\]\s+"
    r"(?P<body>\**\s*Track:.*)$"
)
TRACK_DESC_RE = re.compile(r"^\**\s*Track:\s*(?P<desc>.*?)\s*\**\s*$")
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
CHECKBOX_RE = re.compile(
    r"^(?P<indent>[ \t]*)(?P<bullet>[-*])\s+\[(?P<mark>[ xX~])\]\s?(?P<text>.*)$"
)
PHASE_RE = re.compile(r"^(?P<hashes>#{2,3})\s+(?P<title>.*?)\s*$")
CHECKPOINT_RE = re.compile(r"\s*\[checkpoint:\s*(?P<sha>[0-9a-fA-F]{7,40})\]")
# A recorded SHA is a trailing hex word; requiring a digit avoids mistaking an
# ordinary word such as "defaced" for one.
TRAILING_SHA_RE = re.compile(
    r"^(?P<text>.*?)\s+[\[(`]?(?P<sha>(?=[0-9a-f]*[0-9])[0-9a-f]{7,40})[\])`]?"
    r"\s*$"
)
VERIFICATION_RE = re.compile(
    r"(phase\s+verification|manual\s+verification|verification\s*&\s*checkpoint)",
    re.IGNORECASE,
)
SHA_ARG_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")
SETTINGS_HEADING_RE = re.compile(r"^#{2,3}\s+Execution Settings\s*$",
                                 re.IGNORECASE)
SETTING_RE = re.compile(
    r"^\s{0,3}[-*]\s+\*\*(?P<key>[A-Za-z][A-Za-z ]*?):\*\*\s*`?"
    r"(?P<value>[A-Za-z_-]+)`?"
)
# Execution settings read from workflow.md, with the value used when a
# workflow predates the setting or holds an unknown value.
SETTINGS = {
    "autonomy": ("phase", ("step", "phase", "track")),
    "delegation": ("auto", ("auto", "inline")),
}


class StateError(Exception):
  """An error that is reported to the caller as JSON."""


# ---------------------------------------------------------------------------
# File helpers
# ---------------------------------------------------------------------------


def _now():
  return datetime.datetime.now(datetime.timezone.utc).isoformat(
      timespec="seconds"
  )


def _read_lines(path):
  """Reads a text file keeping line endings, so writes preserve them."""
  with open(path, "r", encoding="utf-8", newline="") as f:
    return f.read().splitlines(keepends=True)


def _write_lines(path, lines):
  with open(path, "w", encoding="utf-8", newline="") as f:
    f.write("".join(lines))


def _eol(lines):
  for line in lines:
    if line.endswith("\r\n"):
      return "\r\n"
    if line.endswith("\n"):
      return "\n"
  return "\n"


def _strip_eol(line):
  return line.rstrip("\r\n")


def _line_ending(line):
  return line[len(_strip_eol(line)):]


def _rel(root, path):
  return os.path.relpath(path, root).replace(os.sep, "/")


def _load_json(path):
  with open(path, "r", encoding="utf-8") as f:
    return json.load(f)


def _dump_json(path, data):
  with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")


# ---------------------------------------------------------------------------
# Project layout
# ---------------------------------------------------------------------------


def resolve_conductor_dir(root, override=None):
  """Finds the Conductor directory for a project root.

  Precedence: an explicit override, then the CONDUCTOR_DIR environment
  variable, then the first candidate directory that contains an index.md, then
  the first candidate directory that exists (a partial setup), and finally the
  default `conductor/`.

  Returns:
    A tuple (absolute path, source) where source is one of "option", "env",
    "detected", "partial", or "default".
  """
  for value, source in ((override, "option"),
                        (os.environ.get(CONDUCTOR_DIR_ENV), "env")):
    if value:
      return os.path.normpath(os.path.join(root, value)), source
  for candidate in CANDIDATE_DIRS:
    path = os.path.join(root, *candidate.split("/"))
    if os.path.isfile(os.path.join(path, "index.md")):
      return path, "detected"
  for candidate in CANDIDATE_DIRS:
    path = os.path.join(root, *candidate.split("/"))
    if os.path.isdir(path):
      return path, "partial"
  return os.path.join(root, DEFAULT_CONDUCTOR_DIR), "default"


class Project:
  """Resolves the locations of Conductor's files for one project root."""

  def __init__(self, root, conductor_dir=None):
    self.root = os.path.abspath(root)
    self.conductor_dir, self.source = resolve_conductor_dir(self.root,
                                                            conductor_dir)
    self.index_path = os.path.join(self.conductor_dir, "index.md")
    self._index_links = None

  def index_links(self):
    """Maps file basenames linked from index.md to absolute paths."""
    if self._index_links is None:
      self._index_links = {}
      if os.path.isfile(self.index_path):
        text = "".join(_read_lines(self.index_path))
        for target in LINK_RE.findall(text):
          target = target.split("#", 1)[0]
          if not target or "://" in target:
            continue
          path = os.path.normpath(os.path.join(self.conductor_dir, target))
          name = os.path.basename(target.rstrip("/")) or target
          self._index_links.setdefault(name, path)
    return self._index_links

  @property
  def registry_path(self):
    return self.index_links().get(
        "tracks.md", os.path.join(self.conductor_dir, "tracks.md")
    )

  @property
  def tracks_dir(self):
    return self.index_links().get(
        "tracks", os.path.join(self.conductor_dir, "tracks")
    )

  @property
  def archive_dir(self):
    return os.path.join(self.conductor_dir, "archive")

  def core_file(self, name):
    return self.index_links().get(name, os.path.join(self.conductor_dir, name))


# ---------------------------------------------------------------------------
# Registry parsing
# ---------------------------------------------------------------------------


def parse_registry(lines):
  """Parses tracks.md lines into track entries.

  Recognizes both `- [ ] **Track: <desc>**` and the legacy
  `## [ ] Track: <desc>` formats. A track's link is the first Markdown link on
  its own line or on the lines that follow, before the next track entry.

  Returns:
    A list of dicts with keys: description, status, mark, line, end, link.
    `line` is the index of the track line; `end` is the index one past the
    last line that belongs to the entry.
  """
  entries = []
  for i, raw in enumerate(lines):
    match = TRACK_LINE_RE.match(_strip_eol(raw))
    if not match:
      continue
    desc_match = TRACK_DESC_RE.match(match.group("body"))
    description = desc_match.group("desc") if desc_match else ""
    entries.append({
        "description": description.strip(),
        "status": MARK_TO_STATUS[match.group("mark")],
        "mark": match.group("mark"),
        "line": i,
        "link": None,
    })
  for n, entry in enumerate(entries):
    stop = entries[n + 1]["line"] if n + 1 < len(entries) else len(lines)
    end = entry["line"] + 1
    for j in range(entry["line"], stop):
      text = _strip_eol(lines[j])
      if j > entry["line"] and (
          text.strip() == "---" or PHASE_RE.match(text) or not text.strip()
      ):
        break
      if entry["link"] is None:
        found = LINK_RE.search(text)
        if found:
          entry["link"] = found.group(1)
      end = j + 1
    entry["end"] = end
  return entries


def _track_dir_from_link(registry_path, link):
  target = link.split("#", 1)[0]
  path = os.path.normpath(os.path.join(os.path.dirname(registry_path), target))
  if os.path.basename(path).lower().endswith(".md"):
    path = os.path.dirname(path)
  return path


def load_tracks(project):
  """Loads registry entries enriched with track directories and ids."""
  if not os.path.isfile(project.registry_path):
    return [], []
  lines = _read_lines(project.registry_path)
  entries = parse_registry(lines)
  for entry in entries:
    if entry["link"]:
      track_dir = _track_dir_from_link(project.registry_path, entry["link"])
      if not os.path.isdir(track_dir):
        # Older registries wrote links relative to the project root
        # (e.g. `./conductor/tracks/<id>/`) instead of relative to tracks.md.
        legacy = _track_dir_from_link(
            os.path.join(project.root, "tracks.md"), entry["link"]
        )
        if os.path.isdir(legacy):
          track_dir = legacy
      entry["dir"] = track_dir
      entry["id"] = os.path.basename(track_dir)
    else:
      entry["dir"] = None
      entry["id"] = None
  return entries, lines


def track_files(track_dir):
  """Resolves spec/plan/metadata paths, honoring links in the track index."""
  files = {
      "index": os.path.join(track_dir, "index.md"),
      "spec": os.path.join(track_dir, "spec.md"),
      "plan": os.path.join(track_dir, "plan.md"),
      "metadata": os.path.join(track_dir, "metadata.json"),
  }
  if os.path.isfile(files["index"]):
    text = "".join(_read_lines(files["index"]))
    for target in LINK_RE.findall(text):
      target = target.split("#", 1)[0]
      name = os.path.basename(target)
      for key, filename in (("spec", "spec.md"), ("plan", "plan.md"),
                            ("metadata", "metadata.json")):
        if name == filename:
          files[key] = os.path.normpath(os.path.join(track_dir, target))
  return files


def find_track(project, query):
  """Finds exactly one registry entry by id or description."""
  entries, _ = load_tracks(project)
  if not entries:
    raise StateError("No tracks found in the tracks registry.")
  exact = [e for e in entries if e["id"] == query]
  if len(exact) == 1:
    return exact[0]
  q = query.lower()
  partial = [
      e for e in entries
      if (e["id"] and q in e["id"].lower()) or q in e["description"].lower()
  ]
  if len(partial) == 1:
    return partial[0]
  candidates = [
      {"id": e["id"], "description": e["description"]}
      for e in (partial or entries)
  ]
  if not partial:
    raise StateError(
        "No track matches '%s'. Candidates: %s" % (query, json.dumps(candidates))
    )
  raise StateError(
      "Track '%s' is ambiguous. Candidates: %s" % (query, json.dumps(candidates))
  )


# ---------------------------------------------------------------------------
# Plan parsing
# ---------------------------------------------------------------------------


def parse_plan(lines):
  """Parses plan.md lines into phases, tasks and sub-tasks.

  Phases are `##`/`###` headings. Within a phase, the checkbox lines with the
  smallest indentation are tasks; more deeply indented checkbox lines are
  sub-tasks of the preceding task. Checkbox lines that appear before any phase
  heading are grouped in an unnamed phase. Phases without tasks are omitted.
  """
  phases = []
  current = {"title": None, "line": None, "checkpoint": None, "items": []}
  for i, raw in enumerate(lines):
    text = _strip_eol(raw)
    heading = PHASE_RE.match(text)
    if heading:
      phases.append(current)
      title = heading.group("title")
      checkpoint = CHECKPOINT_RE.search(title)
      current = {
          "title": CHECKPOINT_RE.sub("", title).strip(),
          "line": i,
          "checkpoint": checkpoint.group("sha") if checkpoint else None,
          "items": [],
      }
      continue
    box = CHECKBOX_RE.match(text)
    if box:
      current["items"].append((i, box))
  phases.append(current)

  result = []
  task_index = 0
  for phase in phases:
    if not phase["items"]:
      continue
    base = min(len(box.group("indent").expandtabs(4))
               for _, box in phase["items"])
    tasks = []
    for i, box in phase["items"]:
      status = MARK_TO_STATUS[box.group("mark")]
      title, sha = box.group("text").strip(), None
      if status == "completed":
        sha_match = TRAILING_SHA_RE.match(title)
        if sha_match:
          title, sha = sha_match.group("text").strip(), sha_match.group("sha")
      item = {"line": i, "status": status, "text": title, "sha": sha}
      if len(box.group("indent").expandtabs(4)) <= base or not tasks:
        task_index += 1
        item["index"] = task_index
        item["subtasks"] = []
        tasks.append(item)
      else:
        tasks[-1]["subtasks"].append(item)
    result.append({
        "title": phase["title"],
        "line": phase["line"],
        "checkpoint": phase["checkpoint"],
        "tasks": tasks,
    })
  for number, phase in enumerate(result, start=1):
    phase["number"] = number
  return result


def _counts(tasks):
  counts = {"total": len(tasks), "completed": 0, "in_progress": 0, "pending": 0}
  for task in tasks:
    counts[task["status"]] += 1
  counts["percent"] = (
      round(100.0 * counts["completed"] / counts["total"], 1)
      if counts["total"] else 0.0
  )
  return counts


def _task_view(task, phase, phase_tasks=None):
  view = {
      "index": task["index"],
      "text": task["text"],
      "status": task["status"],
      "sha": task["sha"],
      "phase": phase["title"],
      "phase_number": phase["number"],
      "is_phase_verification": bool(VERIFICATION_RE.search(task["text"])),
      "subtasks": [
          {"text": s["text"], "status": s["status"]} for s in task["subtasks"]
      ],
  }
  if phase_tasks is not None:
    view["is_last_in_phase"] = task is phase_tasks[-1]
  return view


def summarize_plan(phases):
  all_tasks = [t for p in phases for t in p["tasks"]]
  current = next(
      ((t, p) for p in phases for t in p["tasks"] if t["status"] == "in_progress"),
      None,
  )
  upcoming = next(
      ((t, p) for p in phases for t in p["tasks"] if t["status"] == "pending"),
      None,
  )
  return {
      "phases": [
          dict(
              {"number": p["number"], "title": p["title"],
               "checkpoint": p["checkpoint"]},
              **_counts(p["tasks"])
          )
          for p in phases
      ],
      "tasks": _counts(all_tasks),
      "current_task": _task_view(*current) if current else None,
      "next_task": _task_view(*upcoming) if upcoming else None,
      "complete": bool(all_tasks) and all(
          t["status"] == "completed" for t in all_tasks
      ),
  }


def _load_plan(entry):
  if not entry.get("dir"):
    raise StateError(
        "Track '%s' has no link in the registry." % entry["description"]
    )
  plan_path = track_files(entry["dir"])["plan"]
  if not os.path.isfile(plan_path):
    raise StateError("Plan not found: %s" % plan_path)
  lines = _read_lines(plan_path)
  return plan_path, lines, parse_plan(lines)


def _find_task(phases, number):
  for phase in phases:
    for task in phase["tasks"]:
      if task["index"] == number:
        return task, phase
  raise StateError("Task %d does not exist in the plan." % number)


# ---------------------------------------------------------------------------
# Metadata
# ---------------------------------------------------------------------------


def update_metadata(track_dir, **fields):
  """Merges fields into metadata.json and refreshes `updated_at`."""
  path = track_files(track_dir)["metadata"]
  data = {}
  if os.path.isfile(path):
    try:
      data = _load_json(path)
    except ValueError as e:
      raise StateError("Invalid JSON in %s: %s" % (path, e))
  data.update(fields)
  data["updated_at"] = _now()
  _dump_json(path, data)
  return data


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_tracks(project, _args):
  entries, _ = load_tracks(project)
  tracks = []
  for entry in entries:
    item = {
        "id": entry["id"],
        "description": entry["description"],
        "status": entry["status"],
        "path": _rel(project.root, entry["dir"]) if entry["dir"] else None,
        "exists": bool(entry["dir"] and os.path.isdir(entry["dir"])),
        "progress": None,
    }
    if item["exists"]:
      try:
        _, _, phases = _load_plan(entry)
        item["progress"] = _counts([t for p in phases for t in p["tasks"]])
      except StateError:
        pass
    tracks.append(item)
  return {
      "registry": _rel(project.root, project.registry_path),
      "tracks": tracks,
  }


def cmd_status(project, args):
  if args.track:
    entry = find_track(project, args.track)
    _, _, phases = _load_plan(entry)
    result = {
        "track": {"id": entry["id"], "description": entry["description"],
                  "status": entry["status"]},
    }
    result.update(summarize_plan(phases))
    return result
  overview = cmd_tracks(project, args)
  statuses = [t["status"] for t in overview["tracks"]]
  active = next(
      (t for t in overview["tracks"] if t["status"] == "in_progress"), None
  ) or next((t for t in overview["tracks"] if t["status"] == "pending"), None)
  overview["counts"] = {
      "total": len(statuses),
      "completed": statuses.count("completed"),
      "in_progress": statuses.count("in_progress"),
      "pending": statuses.count("pending"),
  }
  overview["active_track"] = active
  if active and active["exists"]:
    entry = find_track(project, active["id"])
    _, _, phases = _load_plan(entry)
    overview["active_plan"] = summarize_plan(phases)
  return overview


def cmd_next_task(project, args):
  entry = find_track(project, args.track)
  _, _, phases = _load_plan(entry)
  deferred = []
  for wanted in ("in_progress", "pending"):
    for phase in phases:
      for task in phase["tasks"]:
        if (args.skip_verification and task["status"] == wanted
            and VERIFICATION_RE.search(task["text"])):
          deferred.append(_task_view(task, phase, phase["tasks"]))
          continue
        if task["status"] == wanted:
          return {
              "track": entry["id"],
              "resume": wanted == "in_progress",
              "task": _task_view(task, phase, phase["tasks"]),
              "track_complete": False,
          }
  return {"track": entry["id"], "resume": False, "task": None,
          "track_complete": not deferred,
          "deferred_verification_tasks": deferred}


def read_settings(project):
  """Parses the `Execution Settings` section of workflow.md."""
  values, unknown = {}, []
  path = project.core_file("workflow.md")
  if os.path.isfile(path):
    in_section = False
    for raw in _read_lines(path):
      text = _strip_eol(raw)
      if text.startswith("#"):
        in_section = bool(SETTINGS_HEADING_RE.match(text))
        continue
      match = SETTING_RE.match(text) if in_section else None
      if match:
        key = match.group("key").strip().lower().replace(" ", "_")
        values[key] = match.group("value").lower()
  settings = {}
  for key, (default, allowed) in SETTINGS.items():
    value = values.get(key, default)
    if value not in allowed:
      unknown.append("%s=%s" % (key, value))
      value = default
    settings[key] = value
  for key, value in values.items():
    settings.setdefault(key, value)
  return settings, unknown


def cmd_settings(project, _args):
  settings, unknown = read_settings(project)
  result = {"settings": settings}
  if unknown:
    result["warnings"] = [
        "Unknown value %s; using the default instead." % item
        for item in unknown
    ]
  return result


def _set_mark(line, mark):
  box = CHECKBOX_RE.match(_strip_eol(line))
  start = box.start("mark")
  return line[:start] + mark + line[start + 1:]


def _set_task_line(line, status, sha):
  box = CHECKBOX_RE.match(_strip_eol(line))
  text = box.group("text").rstrip()
  existing = TRAILING_SHA_RE.match(text)
  if existing and box.group("mark") in "xX":
    text = existing.group("text").rstrip()
  if status == "completed" and sha:
    text = "%s %s" % (text, sha[:7])
  return "%s%s [%s] %s%s" % (
      box.group("indent"), box.group("bullet"), STATUS_TO_MARK[status], text,
      _line_ending(line),
  )


def cmd_set_task(project, args):
  if args.sha and not SHA_ARG_RE.match(args.sha):
    raise StateError("'%s' is not a commit SHA." % args.sha)
  entry = find_track(project, args.track)
  plan_path, lines, phases = _load_plan(entry)
  task, phase = _find_task(phases, args.task)
  if (args.state == "completed" and VERIFICATION_RE.search(task["text"])
      and not args.user_confirmed):
    raise StateError(
        "Task %d is a verification task. It can only be marked completed after"
        " the user explicitly confirmed the verification; re-run with"
        " --user-confirmed once they have." % task["index"]
    )
  lines[task["line"]] = _set_task_line(lines[task["line"]], args.state, args.sha)
  if args.cascade:
    for sub in task["subtasks"]:
      lines[sub["line"]] = _set_mark(lines[sub["line"]],
                                     STATUS_TO_MARK[args.state])
  _write_lines(plan_path, lines)

  phases = parse_plan(lines)
  task, phase = _find_task(phases, args.task)
  fields = {}
  if args.state != "pending":
    metadata_path = track_files(entry["dir"])["metadata"]
    current = {}
    if os.path.isfile(metadata_path):
      try:
        current = _load_json(metadata_path)
      except ValueError:
        current = {}
    if current.get("status", "new") == "new":
      fields["status"] = "in_progress"
  update_metadata(entry["dir"], **fields)
  summary = summarize_plan(phases)
  return {
      "track": entry["id"],
      "task": _task_view(task, phase, phase["tasks"]),
      "phase_complete": all(t["status"] == "completed" for t in phase["tasks"]),
      "track_complete": summary["complete"],
      "progress": summary["tasks"],
  }


def cmd_set_checkpoint(project, args):
  if not SHA_ARG_RE.match(args.sha):
    raise StateError("'%s' is not a commit SHA." % args.sha)
  entry = find_track(project, args.track)
  plan_path, lines, phases = _load_plan(entry)
  phase = next((p for p in phases if p["number"] == args.phase), None)
  if phase is None or phase["line"] is None:
    raise StateError("Phase %d does not exist in the plan." % args.phase)
  line = lines[phase["line"]]
  heading = CHECKPOINT_RE.sub("", _strip_eol(line)).rstrip()
  lines[phase["line"]] = "%s [checkpoint: %s]%s" % (
      heading, args.sha[:7], _line_ending(line)
  )
  _write_lines(plan_path, lines)
  update_metadata(entry["dir"])
  return {"track": entry["id"], "phase": args.phase, "checkpoint": args.sha[:7]}


def cmd_set_track(project, args):
  entry = find_track(project, args.track)
  if args.state == "completed" and not args.force:
    _, _, phases = _load_plan(entry)
    summary = summarize_plan(phases)
    if not summary["complete"]:
      raise StateError(
          "Track '%s' still has %d unfinished task(s); it cannot be marked"
          " completed. Pass --force only if the user explicitly asked to close"
          " it anyway." % (
              entry["id"],
              summary["tasks"]["total"] - summary["tasks"]["completed"],
          )
      )
  lines = _read_lines(project.registry_path)
  lines[entry["line"]] = _replace_registry_mark(
      lines[entry["line"]], STATUS_TO_MARK[args.state]
  )
  _write_lines(project.registry_path, lines)
  if entry["dir"] and os.path.isdir(entry["dir"]):
    update_metadata(entry["dir"],
                    status=REGISTRY_TO_METADATA_STATUS[args.state])
  return {"track": entry["id"], "status": args.state}


def _replace_registry_mark(line, mark):
  match = TRACK_LINE_RE.match(_strip_eol(line))
  start = match.start("mark")
  return line[:start] + mark + line[start + 1:]


def _slug(text):
  slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
  return slug[:40].rstrip("_") or "track"


def cmd_new_id(project, args):
  date = args.date or datetime.date.today().strftime("%Y%m%d")
  base = "%s_%s" % (_slug(args.short_name), date)
  existing = {e["id"] for e in load_tracks(project)[0] if e["id"]}
  for directory in (project.tracks_dir, project.archive_dir):
    if os.path.isdir(directory):
      existing.update(os.listdir(directory))
  candidate, n = base, 2
  while candidate in existing:
    candidate = "%s_%d" % (base, n)
    n += 1
  return {"id": candidate, "path": _rel(project.root,
                                        os.path.join(project.tracks_dir,
                                                     candidate))}


def cmd_register(project, args):
  if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*$", args.id):
    raise StateError("Invalid track id '%s'." % args.id)
  entries, _ = load_tracks(project)
  if any(e["id"] == args.id for e in entries):
    raise StateError("Track '%s' is already registered." % args.id)
  track_dir = os.path.join(project.tracks_dir, args.id)
  os.makedirs(track_dir, exist_ok=True)
  files = track_files(track_dir)
  warnings = [
      "%s is missing; write it before implementing." % _rel(project.root, p)
      for p in (files["spec"], files["plan"]) if not os.path.isfile(p)
  ]

  metadata = {}
  if os.path.isfile(files["metadata"]):
    metadata = _load_json(files["metadata"])
  now = _now()
  metadata.setdefault("track_id", args.id)
  metadata.setdefault("type", args.type)
  metadata.setdefault("status", "new")
  metadata.setdefault("description", args.description)
  metadata.setdefault("created_at", now)
  metadata["updated_at"] = now
  _dump_json(files["metadata"], metadata)

  if not os.path.isfile(files["index"]):
    _write_lines(files["index"], [
        "# Track %s Context\n" % args.id, "\n",
        "- [Specification](./spec.md)\n",
        "- [Implementation Plan](./plan.md)\n",
        "- [Metadata](./metadata.json)\n",
    ])

  registry = project.registry_path
  lines = _read_lines(registry) if os.path.isfile(registry) else [
      REGISTRY_HEADER
  ]
  eol = _eol(lines)
  if lines and not lines[-1].endswith(("\n", "\r")):
    lines[-1] += eol
  link = _rel(os.path.dirname(registry), files["index"])
  if not link.startswith("."):
    link = "./" + link
  lines += [
      eol, "---", eol, eol,
      "- [ ] **Track: %s**%s" % (args.description, eol),
      "*Link: [%s](%s)*%s" % (link, link, eol),
  ]
  _write_lines(registry, lines)
  index_updated = _ensure_index_tracks_section(project)
  return {
      "id": args.id,
      "path": _rel(project.root, track_dir),
      "registry": _rel(project.root, registry),
      "index_updated": index_updated,
      "warnings": warnings,
  }


def _ensure_index_tracks_section(project):
  """Adds a Tracks section to conductor/index.md if it has none."""
  if not os.path.isfile(project.index_path):
    return False
  lines = _read_lines(project.index_path)
  if "tracks.md" in "".join(lines):
    return False
  eol = _eol(lines)
  if lines and not lines[-1].endswith(("\n", "\r")):
    lines[-1] += eol
  registry = _rel(project.conductor_dir, project.registry_path)
  tracks = _rel(project.conductor_dir, project.tracks_dir)
  lines += [
      eol, "## Tracks", eol, eol,
      "-   [Tracks Registry](./%s)%s" % (registry, eol),
      "-   [Tracks Directory](./%s/)%s" % (tracks, eol),
  ]
  _write_lines(project.index_path, lines)
  project._index_links = None
  return True


def _remove_registry_entry(lines, entry):
  """Removes a track entry and the separator directly above it."""
  start, end = entry["line"], entry["end"]
  j = start - 1
  while j >= 0 and not _strip_eol(lines[j]).strip():
    j -= 1
  if j >= 0 and _strip_eol(lines[j]).strip() == "---":
    start = j
    while start > 0 and not _strip_eol(lines[start - 1]).strip():
      start -= 1
  return lines[:start] + lines[end:]


def cmd_archive(project, args):
  entry = find_track(project, args.track)
  if entry["status"] != "completed" and not args.force:
    raise StateError(
        "Track '%s' is not completed. Pass --force only if the user explicitly"
        " asked to archive it anyway." % entry["id"]
    )
  if not entry["dir"] or not os.path.isdir(entry["dir"]):
    raise StateError("Track directory for '%s' not found." % entry["id"])
  destination = os.path.join(project.archive_dir, entry["id"])
  if os.path.exists(destination):
    raise StateError("%s already exists." % _rel(project.root, destination))
  update_metadata(entry["dir"], archived_at=_now())
  os.makedirs(project.archive_dir, exist_ok=True)
  shutil.move(entry["dir"], destination)
  lines = _read_lines(project.registry_path)
  _write_lines(project.registry_path, _remove_registry_entry(lines, entry))
  return {
      "track": entry["id"],
      "archived_to": _rel(project.root, destination),
  }


def cmd_touch(project, args):
  entry = find_track(project, args.track)
  data = update_metadata(entry["dir"])
  return {"track": entry["id"], "updated_at": data["updated_at"]}


def cmd_locate(project, _args):
  initialized = [
      c for c in CANDIDATE_DIRS
      if os.path.isfile(os.path.join(project.root, *c.split("/"), "index.md"))
  ]
  result = {
      "conductor_dir": _rel(project.root, project.conductor_dir),
      "source": project.source,
      "initialized": os.path.isfile(project.index_path),
      "candidates": list(CANDIDATE_DIRS),
  }
  if len(initialized) > 1:
    result["warnings"] = [
        "Several Conductor directories are initialized (%s); using '%s'. Remove"
        " the stale ones or set %s." % (", ".join(initialized),
                                        result["conductor_dir"],
                                        CONDUCTOR_DIR_ENV)
    ]
  return result


def cmd_doctor(project, args):
  errors, warnings = [], []

  def issue(bucket, code, message, path=None):
    item = {"code": code, "message": message}
    if path:
      item["path"] = _rel(project.root, path)
    bucket.append(item)

  if not os.path.isdir(project.conductor_dir):
    issue(errors, "missing_conductor_dir",
          "Conductor directory not found. Run setup first.",
          project.conductor_dir)
    return _doctor_result(project, errors, warnings, [])
  if not os.path.isfile(project.index_path):
    issue(errors, "missing_index", "index.md not found.", project.index_path)
  for warning in cmd_locate(project, args).get("warnings", []):
    issue(warnings, "multiple_conductor_dirs", warning)
  for name in CORE_FILES:
    path = project.core_file(name)
    if not os.path.isfile(path):
      bucket = errors if name in REQUIRED_CORE_FILES else warnings
      issue(bucket, "missing_core_file",
            "%s (%s) not found." % (CORE_FILES[name], name), path)

  fixed = []
  if not os.path.isfile(project.registry_path):
    issue(warnings, "missing_registry",
          "Tracks registry not found (no tracks created yet).",
          project.registry_path)
    return _doctor_result(project, errors, warnings, fixed)

  entries, _ = load_tracks(project)
  registered_dirs = set()
  if sum(1 for e in entries if e["status"] == "in_progress") > 1:
    issue(warnings, "multiple_in_progress",
          "More than one track is marked in progress.", project.registry_path)
  for entry in entries:
    label = entry["id"] or entry["description"]
    if not entry["link"]:
      issue(errors, "missing_link",
            "Track '%s' has no link in the registry." % label,
            project.registry_path)
      continue
    registered_dirs.add(os.path.normpath(entry["dir"]))
    if not os.path.isdir(entry["dir"]):
      issue(errors, "missing_track_dir",
            "Track '%s' links to a directory that does not exist." % label,
            entry["dir"])
      continue
    files = track_files(entry["dir"])
    for key in ("spec", "plan"):
      if not os.path.isfile(files[key]):
        issue(errors, "missing_%s" % key,
              "Track '%s' has no %s.md." % (label, key), files[key])
    expected = REGISTRY_TO_METADATA_STATUS[entry["status"]]
    if not os.path.isfile(files["metadata"]):
      if args.fix:
        update_metadata(entry["dir"], track_id=entry["id"], status=expected,
                        description=entry["description"])
        fixed.append("Created metadata.json for '%s'." % label)
      else:
        issue(warnings, "missing_metadata",
              "Track '%s' has no metadata.json." % label, files["metadata"])
    else:
      try:
        metadata = _load_json(files["metadata"])
      except ValueError as e:
        issue(errors, "invalid_metadata",
              "metadata.json for '%s' is not valid JSON: %s" % (label, e),
              files["metadata"])
        metadata = None
      if metadata is not None and metadata.get("status") != expected:
        if args.fix:
          update_metadata(entry["dir"], status=expected)
          fixed.append("Set metadata status of '%s' to '%s'." % (label,
                                                                  expected))
        else:
          issue(warnings, "metadata_status_mismatch",
                "Track '%s' is '%s' in the registry but '%s' in metadata.json."
                % (label, entry["status"], metadata.get("status")),
                files["metadata"])
    if os.path.isfile(files["plan"]):
      phases = parse_plan(_read_lines(files["plan"]))
      summary = summarize_plan(phases)
      tasks = summary["tasks"]
      if tasks["total"] == 0:
        issue(warnings, "empty_plan",
              "The plan for '%s' has no tasks." % label, files["plan"])
      if entry["status"] == "completed" and not summary["complete"]:
        issue(warnings, "completed_with_open_tasks",
              "Track '%s' is marked completed but has unfinished tasks." % label,
              files["plan"])
      if entry["status"] == "pending" and (tasks["completed"]
                                          or tasks["in_progress"]):
        issue(warnings, "pending_with_progress",
              "Track '%s' is marked pending but its plan has progress." % label,
              files["plan"])
      if tasks["in_progress"] > 1:
        issue(warnings, "multiple_tasks_in_progress",
              "The plan for '%s' has %d tasks in progress."
              % (label, tasks["in_progress"]), files["plan"])

  if os.path.isdir(project.tracks_dir):
    for name in sorted(os.listdir(project.tracks_dir)):
      path = os.path.normpath(os.path.join(project.tracks_dir, name))
      if os.path.isdir(path) and path not in registered_dirs:
        issue(warnings, "unregistered_track",
              "Track directory '%s' is not listed in the registry." % name,
              path)

  if os.path.isfile(project.index_path) and entries:
    if "tracks.md" not in "".join(_read_lines(project.index_path)):
      if args.fix:
        _ensure_index_tracks_section(project)
        fixed.append("Added a Tracks section to index.md.")
      else:
        issue(warnings, "index_missing_tracks",
              "index.md does not link to the tracks registry.",
              project.index_path)
  return _doctor_result(project, errors, warnings, fixed)


def _doctor_result(project, errors, warnings, fixed):
  return {
      "healthy": not errors,
      "conductor_dir": _rel(project.root, project.conductor_dir),
      "errors": errors,
      "warnings": warnings,
      "fixed": fixed,
  }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser():
  common = argparse.ArgumentParser(add_help=False)
  common.add_argument(
      "--root", default=os.getcwd(),
      help="Project root that contains the Conductor directory (default: cwd).",
  )
  common.add_argument(
      "--conductor-dir",
      help="Conductor directory relative to the root. Defaults to $%s, then"
      " the first initialized of: %s." % (CONDUCTOR_DIR_ENV,
                                         ", ".join(CANDIDATE_DIRS)),
  )
  parser = argparse.ArgumentParser(
      description="Deterministic reads and updates of Conductor state."
  )
  sub = parser.add_subparsers(dest="command", required=True)

  p = sub.add_parser("locate", parents=[common],
                     help="Resolve the Conductor directory.")
  p.set_defaults(func=cmd_locate)

  p = sub.add_parser("doctor", parents=[common],
                     help="Check Conductor state for problems.")
  p.add_argument("--fix", action="store_true",
                 help="Repair safe inconsistencies (metadata, index links).")
  p.set_defaults(func=cmd_doctor)

  p = sub.add_parser("tracks", parents=[common], help="List tracks.")
  p.set_defaults(func=cmd_tracks)

  p = sub.add_parser("status", parents=[common], help="Summarize progress.")
  p.add_argument("--track", help="Track id or description (default: all).")
  p.set_defaults(func=cmd_status)

  p = sub.add_parser("next-task", parents=[common],
                     help="Return the task to work on next.")
  p.add_argument("--track", required=True)
  p.add_argument("--skip-verification", action="store_true",
                 help="Defer verification tasks (for track-level autonomy);"
                 " they are listed in deferred_verification_tasks.")
  p.set_defaults(func=cmd_next_task)

  p = sub.add_parser("settings", parents=[common],
                     help="Read execution settings from workflow.md.")
  p.set_defaults(func=cmd_settings)

  p = sub.add_parser("set-task", parents=[common],
                     help="Change a task's status.")
  p.add_argument("--track", required=True)
  p.add_argument("--task", type=int, required=True,
                 help="Task number, as reported by status/next-task.")
  p.add_argument("--state", choices=sorted(STATUS_TO_MARK), required=True)
  p.add_argument("--sha", help="Commit SHA to record on a completed task.")
  p.add_argument("--cascade", action="store_true",
                 help="Apply the same state to the task's sub-tasks.")
  p.add_argument("--user-confirmed", action="store_true",
                 help="Required to complete a verification task.")
  p.set_defaults(func=cmd_set_task)

  p = sub.add_parser("set-checkpoint", parents=[common],
                     help="Record a phase checkpoint SHA.")
  p.add_argument("--track", required=True)
  p.add_argument("--phase", type=int, required=True,
                 help="Phase number, as reported by status.")
  p.add_argument("--sha", required=True)
  p.set_defaults(func=cmd_set_checkpoint)

  p = sub.add_parser("set-track", parents=[common],
                     help="Change a track's status.")
  p.add_argument("--track", required=True)
  p.add_argument("--state", choices=sorted(STATUS_TO_MARK), required=True)
  p.add_argument("--force", action="store_true",
                 help="Allow completing a track with unfinished tasks.")
  p.set_defaults(func=cmd_set_track)

  p = sub.add_parser("new-id", parents=[common],
                     help="Generate a unique track id.")
  p.add_argument("--short-name", required=True)
  p.add_argument("--date", help="Date as YYYYMMDD (default: today).")
  p.set_defaults(func=cmd_new_id)

  p = sub.add_parser("register", parents=[common],
                     help="Register a new track.")
  p.add_argument("--id", required=True)
  p.add_argument("--description", required=True)
  p.add_argument("--type", default="feature")
  p.set_defaults(func=cmd_register)

  p = sub.add_parser("archive", parents=[common], help="Archive a track.")
  p.add_argument("--track", required=True)
  p.add_argument("--force", action="store_true",
                 help="Allow archiving a track that is not completed.")
  p.set_defaults(func=cmd_archive)

  p = sub.add_parser("touch", parents=[common],
                     help="Refresh a track's updated_at.")
  p.add_argument("--track", required=True)
  p.set_defaults(func=cmd_touch)
  return parser


def main(argv=None):
  args = build_parser().parse_args(argv)
  project = Project(args.root, args.conductor_dir)
  try:
    result = args.func(project, args)
  except StateError as e:
    print(json.dumps({"ok": False, "error": str(e)}, indent=2))
    return 1
  except OSError as e:
    print(json.dumps({"ok": False, "error": str(e)}, indent=2))
    return 1
  output = {"ok": True}
  output.update(result)
  print(json.dumps(output, indent=2))
  return 0


if __name__ == "__main__":
  sys.exit(main())
