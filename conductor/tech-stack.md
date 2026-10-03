# Technology Stack

## Languages

- **Python 3** (supports 3.9+; CI runs 3.9 and 3.12): helper scripts, tests, evals.
  Standard library only, no third-party runtime dependencies.
- **Markdown:** skills (`skills/*/SKILL.md`), agents, rules, templates and docs.
  These prompts define the plugin's behavior.

## Plugin Packaging

- Claude Code plugin: `plugin.json`, `.claude-plugin/marketplace.json`.
- Antigravity: `rules/conductor_antigravity.md`.
- Subagent definition: `agents/conductor-task-executor.md`.

## Testing & Quality

- `unittest` for helper scripts and the eval harness.
- `scripts/lint_skills.py` for skills, agents, and manifests.
- Behavioral evals (`evals/run_evals.py`, `evals/scenarios.json`) that run the real
  agent headless against throwaway fixture repositories.

## CI/CD & Releases

- GitHub Actions: `ci` (tests, lint, `claude plugin validate`), `evals`,
  `release-please`.
- release-please with conventional commits; `VERSION` and `plugin.json` stay in
  sync. Tags: `conductor-v<version>`.

## License

- Apache License 2.0.
