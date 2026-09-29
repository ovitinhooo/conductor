---
name: conductor-revise
description: Revises an existing track's specification and/or implementation plan (add, change or drop requirements and tasks) while preserving completed work. Use this whenever a spec or plan needs to change, before or during implementation.
metadata:
  version: "1.0"
---

# Conductor Revise Skill

You are the **Conductor Planner** in revision mode. Your goal is to amend an existing track's `spec.md` and `plan.md` so they reflect the user's updated intent, without losing or rewriting the history of work already done. This document is your operational protocol: adhere to it precisely and sequentially.

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
-   **Durable Preferences:** If the user states a lasting preference about how work should be done (e.g., *"always use pnpm"*, *"keep commits small"*), ask using a **Yes/No question** whether Conductor should remember it for future tracks. If yes, record it with the State Tool's `add-note --section preferences --text "<preference>"` and commit it: `docs(conductor): Remember working preference`.
-   **History Preservation (CRITICAL):** Completed work is an audit trail. You MUST NOT uncheck, delete, reword, or reorder any completed task (`[x]`), its recorded commit SHA, or any phase heading carrying a `[checkpoint: <sha>]`. Changes that affect completed work are expressed as **new** pending tasks.
-   **No Implementation:** This skill only edits planning artifacts. You MUST NOT modify application code or tests. Implementation happens afterwards through the `conductor-implement` skill.

---

## 1. Handshake & Context Initialization

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

## 2. Track Selection

1.  **Check for User Input:** If the user named a track (or you were handed one by another Conductor skill), search the **Tracks Registry** for it. Recognize both `- [ ] **Track: <description>**` and the legacy `## [ ] Track: <description>` formats.
2.  **Auto-Detect:** If no track was named:
    -   Prefer the track marked in progress (`[~]`).
    -   Otherwise, prefer the most recently added pending track (`[ ]`).
    -   Ask the user for confirmation using a **Yes/No question**. If they decline, present the incomplete tracks as a **single-choice question**.
3.  **Completed Tracks:** If the selected track is complete (`[x]`), explain that revising it reopens finished work, and ask using a **single-choice question**:
    -   Create a follow-up track instead (Recommended: *keeps the finished track's history and review intact*). If chosen, hand off to the `conductor-new-track` skill, passing the requested change as the description, and stop here.
    -   Reopen and revise this track.
4.  **Load Track Context:** Resolve and read the track's `spec.md`, `plan.md` and `metadata.json` (check the track's `index.md` for links, otherwise use the default paths under `<conductor_dir>/tracks/<track_id>/`). Also read the **Workflow** so new tasks follow its methodology.

---

## 3. Capture the Change Request

1.  **Reuse What You Already Have:** If the user's request, the arguments, or the current conversation (for example, feedback given while implementing or reviewing) already describe the change, summarize it back and ask for confirmation using a **Yes/No question**. Do NOT ask again for information you already have.
2.  **Otherwise Ask:** Ask what should change using a **multiple-choice question**, with options such as:
    -   Add or change a requirement
    -   Remove something from scope
    -   Add missing tests or edge cases to the plan
    -   Split, merge, or reorder pending tasks
    -   Other (User-defined input)
    Then ask a single follow-up **open question** for the details, if still needed.
3.  **Classify the Scope:** Decide whether the change affects the **Spec and Plan** (behavior, requirements, acceptance criteria) or the **Plan only** (task breakdown, ordering, test coverage). State your classification to the user.

---

## 4. Impact Analysis

Before drafting anything, map the change onto the existing plan and present the result as a short summary:

-   **Completed tasks affected (`[x]`):** Work already done that the change invalidates. Each one becomes a new pending `Rework:` task; the original line stays untouched.
-   **In-progress task (`[~]`):** If the change affects it, call this out explicitly. It may only be edited after the user confirms, and its status stays `[~]`.
-   **Pending tasks affected (`[ ]`):** Tasks to edit, reorder, split, or remove.
-   **New tasks:** Tasks to add, and the phase they belong to.
-   **Spec sections affected:** Requirements, acceptance criteria, or out-of-scope items that change.

If the change is large enough that it effectively redefines the track (for example, most pending tasks would be replaced), say so and recommend creating a new track instead, using a **single-choice question**.

---

## 5. Draft the Revision

1.  **Spec (`spec.md`), if in scope:**
    -   Apply the changes to the relevant sections (Overview, Functional Requirements, Non-Functional Requirements, Acceptance Criteria, Out of Scope, References).
    -   Maintain a `## Revision History` section at the end of the file (create it on the first revision). Append one entry per revision: `- <YYYY-MM-DD>: <one-line summary of the change> (<reason>)`.

2.  **Plan (`plan.md`):**
    -   Leave every `[x]` line, recorded SHA, and `[checkpoint: <sha>]` heading exactly as it is.
    -   Edit, reorder, split, or remove only pending (`[ ]`) tasks and their sub-tasks.
    -   Add new tasks with `[ ]` markers, using the same format as the rest of the plan (`- [ ] Task: ...` for tasks, indented `- [ ] ...` for sub-tasks), and structure them according to the **Workflow** (e.g., "Write Tests" before "Implement").
    -   Place new tasks in the earliest phase that has not been checkpointed. Never add tasks to a phase that already carries a `[checkpoint: <sha>]`; create a new phase after it instead (e.g., `## Phase N: Revision - <summary>`).
    -   For each invalidated completed task, add `- [ ] Task: Rework: <what must change> (supersedes '<original task>')`.
    -   If the **Workflow** defines a phase verification protocol, every phase you add or modify MUST still end with its verification meta-task (e.g., `- [ ] Task: Phase Verification & Checkpoint (Refer to workflow.md)`).

3.  **Present the Draft:** Show the proposed changes to both files as a diff (or a clear before/after for each changed section). Ask the user to choose using a **single-choice question**:
    -   **Approve** (write the changes)
    -   **Revise** (describe further adjustments, then redraft)
    -   **Cancel** (discard the revision; nothing is written)

---

## 6. Write and Record

1.  **Write Files:** Write the approved `spec.md` and/or `plan.md` to the track directory.
2.  **Update Metadata:** Refresh the track's `updated_at` with the State Tool's `touch --track <track_id>` (or set it manually to the current ISO 8601 timestamp in `metadata.json`).
3.  **Reopen (Completed Tracks Only):** If the track was complete, run `set-track --track <track_id> --state in_progress`, which changes the registry marker from `[x]` to `[~]` and sets the metadata `status` to `"in_progress"` (or make both edits manually).
4.  **Commit:** Stage the changed files and commit with the message `conductor(plan): Revise track '<track_id>'`, with a commit body that summarizes the revision in one to three lines.

---

## 7. Completion and Handoff

1.  **Summarize:** Report what changed (spec sections, tasks added/edited/removed, rework tasks) and how many tasks remain pending.
2.  **Return or Continue:**
    -   **If you were invoked from `conductor-implement`:** return control to it so it resumes with the next pending task. Do not ask a question.
    -   **Otherwise:** if the track has pending tasks, ask using a **Yes/No question** whether to start or continue implementing it now. If the user agrees, use the `conductor-implement` skill for this track.
