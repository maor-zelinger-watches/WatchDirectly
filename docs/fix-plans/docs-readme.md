# Fix plan: fix/docs-readme

**Phase:** P3 · **Ships via:** git push (repo/docs only) · **Files:** `scripts/validate-release.js`, `README.md` (new)

## Findings closed
- **T14 — The release gate's own header describes a deploy mechanism that was removed.** `scripts/validate-release.js:8` says the backend is *"deployed by the post-commit clasp hook"* and L11 says *"Before you commit (which deploys the backend)."* Both false: `deploy-backend.sh` states deploys are skill-invoked and "never a git hook", `setup-backend-deploy.sh` actively `rm -f .git/hooks/post-commit`, and `CHANGELOG.md` records the removal. A reader trusting the header believes committing ships the backend — dangerous in the one script that gates every release.
- **(repo hygiene) — No root `README.md`.** Only `apps-script/README.md` exists; a newcomer landing on the repo gets no orientation. (Secrets, `node_modules`, and test artifacts are already correctly `.gitignore`d — verified.)

## Approach
1. Rewrite the `validate-release.js` header comment: the backend deploys via `npm run deploy:backend`, invoked by the deploy skill **after** this gate passes; committing never deploys.
2. Add a root `README.md`: what the project is, the three independently-versioned components (frontend `APP_VERSION`, backend `VERSION`, repo `version`), how to run (`npm run serve`), test (`npm test`, `test:e2e`, `test:smoke`, `test:perf`), and ship (deploy skill + `validate:release`) — pointing at `apps-script/README.md` for backend specifics.

## Verification
- The header matches `deploy-backend.sh`/`setup-backend-deploy.sh` reality; no remaining reference to a post-commit hook (`git grep -i 'post-commit'` in `scripts/` is clean or only historical).
- README commands all run as written.
