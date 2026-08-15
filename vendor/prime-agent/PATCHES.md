# PATCHES — our local changes on top of upstream prime-agent files

Every file under `vendor/prime-agent/` is a mirror of a prime-agent source file
copied by `scripts/sync-prime-agent.sh`. When we pull a newer upstream tag and
re-run the sync, these copies are overwritten — so any change we make locally
**must be recorded here** and re-applied.

## How to record a patch

1. Edit the vendor file.
2. Add a note below: which file, what we changed, and why.
3. Keep the note short but precise enough to re-apply by hand after a sync.

## Patches

(none yet — see the self-training roadmap; the first candidates will be the
fuzzy edit helper and the autonomous-continue quality gate.)
