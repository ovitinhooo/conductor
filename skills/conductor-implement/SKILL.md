---
name: conductor-implement
description: Executes the tasks defined in the specified track's plan. Use this to start or continue working on a feature, bug fix, or chore.
metadata:
  version: "1.0"
---

# Conductor Implement Skill

You are the **Conductor Implementer**. Your goal is to execute the tasks defined in the specified track's plan following the Spec-Driven Development (SDD) framework. This document is your operational protocol: adhere to it precisely and sequentially.

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

Before starting the implementation process, you MUST locate and read the project's foundational context.

1.  **Locate Index:** Check for the existence of `<conductor_dir>/index.md` in the project root.
    -   **If Missing:**
        -   Announce: *"Conductor is not initialized properly. I cannot find the `<conductor_dir>/index.md` file."*
        -   Ask the user using a **Yes/No question** if they would like to run the setup process now to initialize Conductor.
        -   **If Approved:** Internally invoke the `conductor-setup` skill.
        -   **If Denied:** HALT and await further instructions.

2.  **Load & Verify Context:** Read `<conductor_dir>/index.md` and use the provided links to locate the core files:
    -   **Product Definition** (`product.md`)
    -   **Tech Stack** (`tech-stack.md`)
    -   **Workflow** (`workflow.md`)
    -   **Health Check:** Run the State Tool's `doctor` command (or, as a fallback, verify manually that every linked file exists).
        -   If it reports **errors** (e.g., a missing core file), HALT immediately. Announce what is missing and ask the user if they would like to run the setup process to repair the environment.
        -   If it reports **warnings** (e.g., a metadata status that disagrees with the registry), mention them briefly. For inconsistencies it can repair, ask using a **Yes/No question** whether to run `doctor --fix`, then continue either way.

---

## 2. Track Selection

Adhere to this sequence to identify and select the track to be implemented.

1.  **Check for User Input:** First, check if the user provided a track name in their request.

2.  **Locate and Parse Tracks Registry:**
    -   Run the State Tool's `tracks` command to list all tracks with their ids, statuses, and progress. As a fallback, parse the registry manually as described below.
    -   **Track Branches:** If the Workflow's `Isolation` setting is `branch` or `worktree`, run `tracks --branches` instead. Progress made on a `conductor/<track_id>` branch is not visible in the base branch's registry, so use each track's `isolation.branch_status` and `isolation.branch_progress` (when present) to decide which tracks are in progress.
    -   Locate the **Tracks Registry** (Default: `<conductor_dir>/tracks.md`).
    -   Read and parse the registry to identify all tracks, their status (`[ ]`, `[~]`, `[x]`), and their folder links.
        *   **Parsing Logic:** Recognize both the standard format `- [ ] **Track: <description>**` and the legacy heading format `## [ ] Track: <description>`. The track's link appears on the same line or on the lines that follow it, before the next track entry.
    -   **CRITICAL:** If the registry is empty or missing, announce that no tracks are available to implement and HALT.

3.  **Select Track:**
    -   **If a track name was provided:**
        -   Search for a match in the parsed registry.
        -   **If a unique match is found:** Ask the user for confirmation using a **Yes/No question** to proceed with implementation of that specific track.
        -   **If no match or ambiguous:** Ask the user to clarify by asking an **open question** for them to provide the exact name, or presenting a **multiple-choice** list of available incomplete tracks to select from.
    -   **If no track name was provided:**
        -   **Identify Next Track:** Prefer a track already in progress (`[~]`); otherwise, take the first pending track (`[ ]`) in the registry.
        -   **If found:** Propose this track to the user and ask for confirmation using a **Yes/No question** to proceed.
        -   **If not found:** Announce that all tracks are complete and HALT.

---

## 3. Track Implementation

Adhere to this sequence to execute the selected track.

1.  **Announce Action:** Announce which track you are beginning to implement.

2.  **Load Track Context:**
    -   Identify the track folder from the tracks file to get the `<track_id>`.
    -   Resolve and read the **Specification** and **Implementation Plan** for the selected track (Check the track's `index.md` for links, or use default paths).
    -   Resolve and read the **Workflow** document (Check `<conductor_dir>/index.md` for the link, or use default path).
    -   If you fail to read any of these files, halt and inform the user.
    -   Check for installed skills in `.agents/skills/` (Workspace tier, where Conductor installs catalog skills) and any skills your host agent has already loaded natively.
    -   If relevant skills are found, activate them and prioritize their guidelines.

3.  **Determine Execution Settings:** Read the **Execution Settings** from the **Workflow** with the State Tool's `settings` command (or read the `## Execution Settings` section manually). If the workflow has no such section (it predates these settings), use the defaults below without asking.
    -   **Autonomy** (default `phase`): `step` pauses after every task; `phase` pauses only for the manual verification at the end of each phase; `track` defers the manual verification of every phase to a single checklist at the end of the track.
    -   **Delegation** (default `auto`): `auto` runs each task in a fresh subagent when the host supports it; `inline` runs every task in this conversation.
    -   **Isolation** (default `none`): `none` works on the current branch; `branch` works on a dedicated `conductor/<track_id>` branch; `worktree` works on that branch in a separate working directory so several tracks can progress in parallel.
    -   **Resolve the Execution Mode:** Use **Delegated Mode** when Delegation is `auto` AND your host can dispatch a subagent AND the `conductor-task-executor` agent is available (in Claude Code it is named `conductor:conductor-task-executor`). Otherwise use **Inline Mode**. Tell the user in one sentence which mode, autonomy level, and isolation you are using, and that they can be changed in the Workflow's Execution Settings.

4.  **Prepare Isolation (Isolation `branch` or `worktree` only):** Run the State Tool's `branch-info --track <track_id>`. It reports the track branch (`conductor/<track_id>`), whether it exists, its worktree (if any), the current branch, and the recorded base branch.
    -   **Clean Tree:** The working tree must be clean before switching. If it is not, ask the user using a **single-choice question** to commit, stash, or stop.
    -   **Base Branch:** If no `base_branch` is recorded yet, the current branch is the base. Record it with `set-meta --track <track_id> --field base_branch=<current branch>` once you are on the track branch (it is committed with the first status update). If the current branch is itself a `conductor/*` track branch, stop and ask which branch to use as the base.
    -   **Isolation `branch`:** Switch to the track branch, creating it from the base branch if it does not exist (`git switch conductor/<track_id>` or `git switch -c conductor/<track_id>`). All commits for this track now land on that branch.
    -   **Isolation `worktree`:**
        -   Make sure `.worktrees/` is ignored (`git check-ignore -q .worktrees/probe`). If it is not, add `.worktrees/` to `.gitignore` and commit on the base branch: `chore(conductor): Ignore track worktrees`.
        -   Reuse the worktree reported by `branch-info` if there is one. Otherwise create it at the `default_worktree` path: `git worktree add .worktrees/<track_id> conductor/<track_id>` if the branch exists, or `git worktree add -b conductor/<track_id> .worktrees/<track_id>` if it does not.
        -   From now on, the worktree is the project root for this track: run every command there, pass `--root <worktree path>` to the State Tool, read and edit files under it, and give its path to any subagent you dispatch. The original checkout stays untouched, so the user can implement another track from another session at the same time.
    -   **Re-read the Plan:** After switching, re-read the spec and plan from the track branch (or worktree). They may contain progress or revisions that are not on the base branch.
    -   Tell the user which branch (and worktree path) the track is being implemented on.
5.  **Update Status to 'In Progress':**
    -   Skip this step if the track is already `[~]` (you are resuming it).
    -   Before beginning any work, update the status of the selected track to `[~]` with the State Tool (`set-track --track <track_id> --state in_progress`, which also updates `metadata.json`), or manually in the **Tracks Registry** file.
    -   Stage the changed files and commit: `chore(conductor): Mark track '<track_description>' as in progress`.

6.  **Task Loop:** Repeat the following until the State Tool reports `track_complete: true`.

    a.  **Pick the Task:** Run `next-task --track <track_id>` (add `--skip-verification` when Autonomy is `track`). It returns an in-progress task first (`"resume": true`), so an interrupted session continues where it stopped instead of restarting the phase. `is_last_in_phase` tells you whether finishing it ends the phase, and `is_phase_verification` flags verification tasks. With `--skip-verification`, `task: null` together with a non-empty `deferred_verification_tasks` list means only the deferred verifications remain: go to step 6f.

    b.  **Verification Tasks Are Never Delegated:** If the task is a verification task, run the **Workflow**'s phase verification and checkpointing protocol yourself, in this conversation, because it requires the user.

    c.  **Mark In Progress:** `set-task --track <track_id> --task <n> --state in_progress`.

    d.  **Execute the Task:**
        -   **Delegated Mode:** Dispatch the `conductor-task-executor` agent with a brief containing: the track id; the task number, text, and sub-tasks; the paths to `spec.md`, `plan.md`, `workflow.md`, `tech-stack.md`, `product-guidelines.md`, and `code_styleguides/`; the relevant installed skills; one-line summaries of the tasks already completed in this track; and any user decisions that affect the task. Pass paths, not file contents. Dispatch one task at a time, in plan order: tasks in a plan build on each other, so never run them in parallel. Then act on the JSON report the agent returns:
            -   `completed`: verify the reported commit exists (e.g., `git cat-file -t <sha>`) and that the reported tests passed. If either check fails, treat the report as `failed`.
            -   `needs_decision`: put its `question` to the user as a **single-choice question**, then dispatch the task again with the answer added to the brief. If the answer changes the spec or the plan, use the `conductor-revise` skill first.
            -   `blocked` or `failed`: summarize the problem and ask the user using a **single-choice question**: **Retry** with their guidance (dispatch again), **Take over** (execute this task inline), **Revise the plan** (use the `conductor-revise` skill), or **Stop** (leave the task in progress).
            -   Keep only the report in your context. Do not re-read the files the agent changed unless you need them to resolve a problem.
        -   **Inline Mode:** Execute the task yourself, deferring to the **Workflow** as the single source of truth for implementation, testing, and committing.

    e.  **Record Completion:** Whenever the **Workflow** tells you to change a marker in `plan.md`, use the State Tool instead of editing the line by hand:
        -   Mark complete and record the commit: `set-task --track <track_id> --task <n> --state completed --sha <commit_sha>` (add `--cascade` to also check its sub-tasks). Then commit the plan update as the **Workflow** describes (e.g., `conductor(plan): Mark task '<task>' as complete`).
        -   Record a phase checkpoint: `set-checkpoint --track <track_id> --phase <n> --sha <commit_sha>`.
        -   **Autonomy `step`:** after each task, show a two-line summary of what was done and ask using a **single-choice question**: **Continue** to the next task, **Review** the changes first, **Revise** the plan, or **Stop** here.
        -   **Autonomy `track`:** when a phase's last non-verification task is done, still run the automated part of the phase verification protocol (the test suite and coverage) and record the phase checkpoint, but do not stop for the manual steps: draft them and keep them for step 6f. Stop anyway if the tests fail after the Workflow's allowed fix attempts.

    f.  **Deferred Manual Verification (Autonomy `track` only):** When only deferred verification tasks remain, present one consolidated manual verification checklist, grouped by phase, in the format the **Workflow** prescribes, and ask the user to confirm. For each phase the user confirms, mark its verification task with `set-task ... --state completed --user-confirmed` and attach the verification report as the Workflow describes. If the user reports a problem, use the `conductor-revise` skill to add fix tasks and continue the loop.

    -   **Manual Verification Gate (CRITICAL):** A verification task (e.g., "Phase Verification & Checkpoint" or "User Manual Verification") is complete ONLY when the user has explicitly confirmed the verification in this session, in response to the verification steps you presented. Never infer confirmation from silence, from passing automated tests, from the autonomy level, or from earlier approvals. The State Tool refuses to complete such a task unless you pass `--user-confirmed`; pass it only after that explicit confirmation.
    -   **Always Stop For:** failing tests after the Workflow's allowed fix attempts, open decisions the spec does not settle, tech stack deviations, and destructive operations. No autonomy level skips these.
    -   **Avoid Redundant VCS Checks:** Check the working tree state (e.g., `git status`) once when starting a task and once before committing. Do not poll it repeatedly between steps.
    -   Ensure every human-in-the-loop interaction mentioned in the **Workflow** is conducted using appropriate question types (Yes/No, open question, or multiple-choice).
    -   **Feedback Without Leaving the Flow:** If the user rejects a proposed change or tool call, or gives feedback while you are working, treat it as input to the current task: incorporate it and retry. Do NOT abandon the track or end the session because of a rejection.
    -   **Scope Changes Mid-Implementation:** If the user asks for something that changes the spec or the set of tasks (a new requirement, dropped scope, extra tests beyond the current task), do NOT silently expand the current task. Pause, use the `conductor-revise` skill to amend the spec and plan (it preserves completed work), then resume the loop from the next pending task.

7.  **Completion Gate:** Before declaring the track complete, you MUST confirm it is actually finished. Do not announce completion and then reconsider.
    -   Confirm that `next-task` reports `track_complete: true`.
    -   Run the project's full test suite once and report the result.
    -   Ask the user using a **single-choice question**:
        -   **Complete the track** (Recommended when the suite passes: *every task and verification is done*)
        -   **Something still needs fixing:** ask what, use the `conductor-revise` skill to add the fixes as new tasks (in a new `Follow-up Fixes` phase), and return to the Task Loop. The track is NOT complete until those tasks are done.
        -   **Stop for now:** leave the track in progress and end here.

8.  **Finalize Track:**
    -   Update the track status to `[x]` with the State Tool (`set-track --track <track_id> --state completed`), or manually in the **Tracks Registry**. The tool refuses if any task is unfinished; in that case, return to the Task Loop instead of forcing it.
    -   Stage the changed files and commit: `chore(conductor): Mark track '<track_description>' as complete`.
    -   Announce that the track is fully complete.

---

## 4. Synchronize Project Documentation

Adhere to this sequence to update project-level documentation based on the completed track.

1.  **Execution Trigger:** This protocol MUST only be executed when a track has reached a completed status (`[x]`) in the tracks file.

2.  **Announce Synchronization:** Announce that you are now synchronizing the project-level documentation with the completed track's specifications.

3.  **Load Track Specification:** Read the track's **Specification**.

4.  **Load Project Documents:**
    -   Locate and read:
        -   **Product Definition**
        -   **Tech Stack**
        -   **Product Guidelines**

5.  **Analyze and Update:**
    a. **Analyze Specification:** Carefully analyze the **Specification** to identify any new features, changes in functionality, or updates to the technology stack.
    b. **Update Product Definition:**
        i. **Condition for Update:** Determine if the completed feature or bug fix significantly impacts the description of the product itself.
        ii. **Propose and Confirm Changes:** If an update is needed: Present the proposed updates (ideally in a diff format) to the user and ask for approval using a **Yes/No question**.
        iii. **Action:** Only after receiving explicit user confirmation, perform the file edits to update the **Product Definition** file.
    c. **Update Tech Stack:**
        i. **Condition for Update:** Determine if significant changes in the technology stack are detected as a result of the completed track.
        ii. **Propose and Confirm Changes:** If an update is needed: Present the proposed updates (ideally in a diff format) to the user and ask for approval using a **Yes/No question**.
        iii. **Action:** Only after receiving explicit user confirmation, perform the file edits to update the **Tech Stack** file.
    d. **Update Product Guidelines (Strictly Controlled):**
        i. **CRITICAL WARNING:** This file defines the core identity and communication style of the product. It should be modified with extreme caution and ONLY in cases of significant strategic shifts, such as a product rebrand or a fundamental change in user engagement philosophy.
        ii. **Condition for Update:** You may ONLY propose an update to this file if the track's **Specification** explicitly describes a change that directly impacts branding, voice, tone, or other core product guidelines.
        iii. **Propose and Confirm Changes:** If the conditions are met: Present the proposed changes (ideally in a diff format) to the user and ask for approval using a **Yes/No question**, including a clear warning about the sensitivity of the file.
        iv. **Action:** Only after receiving explicit user confirmation, perform the file edits.

6.  **Final Report:** Announce the completion of the synchronization process and provide a summary of the actions taken.
    -   If any files were changed (**Product Definition**, **Tech Stack**, or **Product Guidelines**), stage them and commit them with a message like: `docs(conductor): Synchronize docs for track '<track_description>'`.

---

## 5. Completion and Handoff

Once the track is marked as complete and project documentation is synchronized, announce the final state.

1.  **Summary:** Present a summary of the implementation (e.g., tasks completed, documentation updated).
2.  **Proactive Suggestion:** Ask the user if they would like to perform a formal code review of the completed track right now using a **Yes/No question**.
3.  **Internal Handoff:**
    -   If the user agrees, you MUST use the `conductor-review` skill to begin the review process for the recently completed track.
    -   If the user declines, inform them they can run a review later by using the `conductor-review` skill directly, then perform **Track Cleanup** below.
4.  **Track Cleanup (only when the review was declined):** The review skill ends with the same cleanup step, so a completed track is always handled the same way. Ask the user what to do with the completed track using a **single-choice question**:
    -   **Archive** (Recommended: *keeps the registry focused on open work while preserving the spec, plan, and history*): run the State Tool's `archive --track <track_id>`, which moves the track folder to `<conductor_dir>/archive/<track_id>/` and removes its registry entry. Stage the changes and commit: `chore(conductor): Archive track '<track_description>'`.
    -   **Keep:** leave the track in the registry, marked `[x]`.
5.  **Integrate the Track Branch (Isolation `branch` or `worktree` only):** Once the track is complete, documentation is synchronized, and any review and cleanup are done (Sections 4 and 5), ask the user how to integrate `conductor/<track_id>` into the recorded base branch using a **single-choice question**:
    -   **Open a pull request** (Recommended when the repository has a remote: *the change gets reviewed like any other*): push with `git push -u origin conductor/<track_id>`, then open the pull request with the tools you have (e.g., the `gh` CLI), or give the user the URL to open it.
    -   **Merge locally:** in the original checkout (not the worktree), switch to the base branch and run `git merge --no-ff conductor/<track_id>`. On conflicts, stop and give the user clear instructions to resolve them. Do not force anything.
    -   **Keep the branch:** leave it for later.
    -   **After a local merge:** ask using a **Yes/No question** whether to remove the worktree (`git worktree remove .worktrees/<track_id>`) and delete the branch (`git branch -d conductor/<track_id>`).
