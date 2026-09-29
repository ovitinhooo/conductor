# How to contribute

We'd love to accept your patches and contributions to this project.

## Before you begin

### Sign our Contributor License Agreement

Contributions to this project must be accompanied by a
[Contributor License Agreement](https://cla.developers.google.com/about) (CLA).
You (or your employer) retain the copyright to your contribution; this simply
gives us permission to use and redistribute your contributions as part of the
project.

If you or your current employer have already signed the Google CLA (even if it
was for a different project), you probably don't need to do it again.

Visit <https://cla.developers.google.com/> to see your current agreements or to
sign a new one.

### Review our community guidelines

This project follows
[Google's Open Source Community Guidelines](https://opensource.google/conduct/).

## Contribution process

### Code reviews

All submissions, including submissions by project members, require review. We
use GitHub pull requests for this purpose. Consult
[GitHub Help](https://help.github.com/articles/about-pull-requests/) for more
information on using pull requests.
## Development

Conductor's behavior lives in the skills (`skills/*/SKILL.md`), which are
prompts, plus small helper scripts. Before sending a pull request, run the fast
checks that CI runs:

```bash
python3 -m unittest discover -s tests   # helper scripts and eval harness
python3 scripts/lint_skills.py          # skills, agents, and manifests
```

The linter catches broken frontmatter, unbalanced or collapsed code blocks,
references to files, skills, agents, or state tool options that do not exist,
drift between the two copies of `catalog.md`, and version mismatches between
`VERSION` and `plugin.json`.

### Behavioral evals

Changes to a skill's protocol should also pass the behavioral evals, which run
the real agent headless against throwaway fixture repositories and check the
artifacts it leaves behind:

```bash
python3 evals/run_evals.py --list       # available scenarios
python3 evals/run_evals.py --dry-run    # build fixtures without calling a model
python3 evals/run_evals.py --scenario implement-verification-gate
```

A real run needs the `claude` CLI and credentials, costs model usage (capped by
`--max-budget-usd` per scenario), and uses `--permission-mode
bypassPermissions` inside temporary directories, so run it in a disposable
environment. Maintainers can also run the `evals` workflow from the Actions
tab once the `ANTHROPIC_API_KEY` secret is set.

### Releases

Releases are cut by release-please from conventional commit messages. It bumps
`VERSION` and `plugin.json` together and tags releases as
`conductor-v<version>`.
