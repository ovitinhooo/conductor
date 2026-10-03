# Initial Concept

Conductor is a plugin for AI coding agents (Claude Code, Antigravity) that enables
Spec-Driven Development: "Measure twice, code once."

# Conductor Plugin

## Vision

Turn an AI coding agent into a proactive project manager that follows a strict,
repeatable protocol to specify, plan, and implement software features and bug
fixes. Project context lives in the repository as a managed artifact, so every
agent interaction has deep, persistent awareness of the product, standards, and
history.

## Target Users

- Developers and teams who use AI coding agents and want controlled, reviewable
  work instead of ad-hoc code generation.
- Teams that want shared project context (product, tech stack, workflow) as a
  foundation for every contributor and agent.
- Maintainers of both new (greenfield) and existing (brownfield) projects.

## Core Features

- **Setup:** Scaffold project context (product, guidelines, tech stack, workflow,
  code style guides) for new and existing projects.
- **Tracks:** Plan each feature or bug fix as a track with a spec, a phased plan,
  and metadata.
- **Implement:** Execute plan tasks with TDD, per-task commits, git notes,
  phase checkpoints, and manual verification gates.
- **Execution settings:** Configurable autonomy (step/phase/track), delegation to
  fresh-context subagents, and isolation (none/branch/worktree).
- **Status, Review, Revert, Revise:** Monitor progress, review work against the
  plan and guidelines, undo work by logical unit, and revise specs and plans
  while preserving completed work.
- **Memory between tracks:** Learnings, working preferences, and conventions
  recalled by later tracks.
- **Skill catalog:** Optional installation of additional agent skills (first- and
  third-party, pinned to frozen commits).

## Goals

- Make agent work predictable: no code before an approved spec and plan.
- Keep the repository the single source of truth for context and progress.
- Stay portable across agent hosts, adapting the UX to the host's capabilities.
- Keep state handling deterministic through a tested helper script instead of
  hand-edited Markdown/JSON.
