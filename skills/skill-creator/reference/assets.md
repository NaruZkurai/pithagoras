# Supporting files

Everything beside `SKILL.md` in the folder travels with the skill. None of it
is loaded automatically — you open it when the skill tells you to, which is
exactly why it is worth splitting things out: the detail stays out of context
until it is needed.

## When to split

Keep it in `SKILL.md` if it is the procedure. Move it out when it is:

- **Detail you need occasionally** — an API's full parameter list, error codes,
  a table of flags.
- **Long examples** — one in the body is orientation, six is a reference file.
- **Something to run** rather than read.
- **Something to copy** — a config template, a boilerplate file.

A `SKILL.md` over roughly 200 lines is usually carrying something that belongs
in a reference file.

## Layout

```
my-skill/
  SKILL.md
  reference/
    api.md
    errors.md
  scripts/
    check.sh
  templates/
    config.example.yml
```

The directory names are convention, not enforced. Consistency is the point.

## Pointing at them

Always by relative path, always with a reason to open it:

```markdown
Read `reference/errors.md` when a call fails — the retryable codes are not the
ones you would guess.

Copy `templates/config.example.yml` and fill in the two marked fields.
```

Say **when**, not just that the file exists. "See reference/api.md" gets
ignored; "read reference/api.md before writing the request, pagination is
non-obvious" gets used.

## Scripts

A script is worth shipping when the alternative is retyping something fiddly,
or when correctness matters more than flexibility.

```bash
#!/usr/bin/env bash
# check.sh — verify the migration applied cleanly.
# Exits non-zero with a reason if anything is missing.
set -euo pipefail
```

- `chmod +x` it, or it will not run.
- Give it a shebang. Do not assume bash is at `/bin/bash`.
- `set -euo pipefail` so a failing step fails the script rather than continuing.
- Make failure loud and specific: the exit message is what you will be reading.
- Say in `SKILL.md` what a non-zero exit means.

Prefer a script that checks over a script that fixes. Something that reports
"three rows missing from `users`" is more useful than something that silently
repairs and leaves you unsure what happened.

## What not to put here

- **Secrets.** Skills are files on disk, shared across every session, and
  readable by anyone with access to the portal. A skill can say *which*
  credential is needed and where it lives, never what it is.
- **Anything large.** A binary or a big dataset does not belong in a skill
  folder; reference where it lives instead.
- **Anything that goes stale silently.** A copied snapshot of documentation
  will be wrong within months, and nothing will tell you. Link to it, or say
  how to regenerate it.
