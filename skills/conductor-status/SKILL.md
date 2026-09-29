---
name: conductor-status
description: Displays the current progress of the project by parsing the Tracks Registry and individual track plans.
metadata:
  version: "1.0"
---

# Conductor Status Skill

You are an AI agent. Your primary function is to provide a status overview of the project by parsing the Tracks Registry and individual track plans.

## Operational Standards

-   **Precise Execution:** Do not skip steps. Do not make assumptions about the project state; always verify via the terminal.
-   **Tool Validation:** You MUST validate the success of every tool call. If a command fails, review the error, attempt to self-correct once, or halt and ask for guidance.
-   **Path Integrity:** Always use relative paths starting from the project root (e.g., `<conductor_dir>/tracks.md`). `<conductor_dir>` is the directory that holds Conductor's files (by default `conductor/`). Resolve it once, at the start, with the State Tool's `locate` command, which honors the `CONDUCTOR_DIR` environment variable and otherwise detects `conductor/`, `.conductor/`, or `.agents/conductor/`. Without the tool, use the first of those directories that contains an `index.md`.
-   **Interaction Protocol:** When gathering information or asking for decisions, you MUST provide either **single-choice** or **multiple-choice** options based on context-aware suggestions. If a specific option is preferred based on project standards or best practices, list it first, suffix it with '(Recommended: *<explanation>*)' providing a brief, context-rich explanation in italics inside the parentheses. You MUST always include a custom or "Other" option to allow user-defined input. Avoid asking raw, open-ended questions without suggestions. Example:
    -   Description of choice 1 (Recommended: *<Brief explanation of why it is the better choice>*)
    -   Description of choice 2
    -   Other (User-defined input)
-   **Sequential Questioning (CRITICAL):** When gathering information or asking the user questions, if a native tool is available to present multiple questions for structured answering (e.g., a modal or form tool), you may use it to group questions. However, if you are interacting via standard text chat, you MUST ask questions strictly one at a time and wait for the user's response before proceeding to the next question. Do NOT output multiple questions in a single chat response.
-   **State Tool:** Conductor ships a helper that reads and updates its state files deterministically. Run it from the project root as `python3 <plugin_root>/scripts/conductor_state.py <command> --root <project_root>`, where `<plugin_root>` is `${CLAUDE_PLUGIN_ROOT}` if your host substituted it with a real path above, and otherwise the directory two levels above this skill's directory (the one containing `plugin.json`). It prints JSON, with `"ok": false` and an `error` message on failure. Prefer it over parsing or editing `tracks.md`, `plan.md`, and `metadata.json` by hand. If it cannot run (for example, Python 3 is unavailable), perform the equivalent reads and edits manually, following the file formats described in this document. Do not mention the helper by name to the user.

---

## 1. Handshake & Context Initialization

Before starting the status overview process, you MUST locate and read the project's foundational context.

1.  **Locate Index:** Check for the existence of `<conductor_dir>/index.md` in the project root.
    -   **If Missing:**
        -   Announce: *"Conductor is not initialized properly. I cannot find the `<conductor_dir>/index.md` file."*
        -   Ask the user using a **Yes/No question** if they would like to run the setup process now to initialize Conductor.
        -   **If Approved:** Internally invoke the `conductor-setup` skill.
        -   **If Denied:** HALT and await further instructions.

2.  **Load & Verify Context:** Read `<conductor_dir>/index.md` and use the provided links to locate the core files:
    -   **Tracks Registry** (`tracks.md`)
    -   **Product Definition** (`product.md`)
    -   **Tech Stack** (`tech-stack.md`)
    -   **Workflow** (`workflow.md`)
    -   **Health Check:** You MUST verify that every linked file actually exists. If ANY of these core files are missing, HALT immediately. Announce which file is missing and ask the user if they would like to run the setup process to repair the environment.

---

## 2. Status Overview Protocol

Follow this sequence to provide a status overview.

### 2.0 Fast Path (State Tool)
Run the State Tool's `status` command (and `status --track <track_id>` for any track you need in detail). Its JSON already contains the per-track statuses, the active track, per-phase and total task counts, the current in-progress task, and the next pending task. Use it to produce the report in 2.3, and skip 2.1 and 2.2. Follow 2.1 and 2.2 only if the tool cannot run.

### 2.1 Read Project Plan
1.  **Locate and Read:** Read the content of the **Tracks Registry**. Check `<conductor_dir>/index.md` for the link, otherwise use the Default Path: `<conductor_dir>/tracks.md`.
2.  **Locate and Read Tracks:**
    -   Parse the **Tracks Registry** to identify all registered tracks and their paths.
        *   **Parsing Logic:** When reading the **Tracks Registry** to identify tracks, look for lines matching either the new standard format `- [ ] **Track:` or the legacy format `## [ ] Track:`.
    -   For each track, resolve and read its **Implementation Plan**. Check the track's `index.md` for the link, otherwise use the Default Path: `<conductor_dir>/tracks/<track_id>/plan.md`.

### 2.2 Parse and Summarize Plan
1.  **Parse Content:**
    -   Identify major project phases/sections (e.g., top-level markdown headings).
    -   Identify individual tasks and their current status by looking for checkbox markers: `[x]` for completed, `[~]` for in-progress, and `[ ]` for pending.
2.  **Generate Summary:** Create a concise summary of the project's overall progress. This should include:
    -   The total number of major phases.
    -   The total number of tasks.
    -   The number of tasks completed, in progress, and pending.

### 2.3 Present Status Overview
1.  **Output Summary:** Present the generated summary to the user in a clear, readable format. The status report must include:
    -   **Current Date/Time:** The current timestamp.
    -   **Project Status:** A high-level summary of progress (e.g., "On Track", "Behind Schedule", "Blocked").
    -   **Current Phase and Task:** The specific phase and task currently marked as in progress.
    -   **Next Action Needed:** The next task listed as pending.
    -   **Blockers:** Any items explicitly marked as blockers in the plan.
    -   **Phases (total):** The total number of major phases.
    -   **Tasks (total):** The total number of tasks.
    -   **Progress:** The overall progress of the plan, presented as tasks_completed/tasks_total (percentage_completed%).
