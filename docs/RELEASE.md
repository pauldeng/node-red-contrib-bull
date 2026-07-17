# Release Guide

Checklist for publishing `@pauldeng/node-red-contrib-bullmq` to npm and the
Node-RED Flow Library, following current (2025-2026) supply-chain practice.

Publishing uses **npm trusted publishing (OIDC)** from GitHub Actions. There is
no long-lived `NPM_TOKEN`: the release workflow mints a short-lived OIDC
credential per run and attaches build provenance automatically. (Classic npm
tokens were revoked in December 2025; only granular tokens remain, and they are
used here only for the one-time first publish.)

## 1. Preflight

1. Confirm `package.json` has the intended `version` and the name `@pauldeng/node-red-contrib-bullmq`.
2. Confirm the GitHub repository is `https://github.com/pauldeng/node-red-contrib-bullmq`.
3. Confirm BullMQ is pinned to exactly `5.80.6`.
4. Confirm no examples, docs, fixtures, or logs contain Redis, Sentinel, or MemoryDB secrets.
5. Update `CHANGELOG.md` for the new version.

## 2. Local verification

```sh
npm ci
npm test                                  # unit + contract tests
npm run test:playwright                   # editor tests
npm run format:check                      # prettier gate
npm run validate                          # Node-RED scorecard preflight (node-red-dev)
npm audit --omit=dev --audit-level=moderate
npm pack --dry-run                        # confirm the tarball is clean
```

For deployment changes, also run:

```sh
npm run test:deployments
```

MemoryDB verification is opt-in and environment-only:

```sh
MEMORYDB_ENABLED=1 npm run test:deployments
```

## 3. One-time account and repository setup

Do these once, before the first release.

### npm account

- [ ] Enable 2FA for authorization and writes: `npm profile enable-2fa auth-and-writes`.
- [ ] Make sure the `@pauldeng` scope exists and you can publish under it.
- [ ] Create a short-lived **granular** access token (write scope, this package only) for the one-time first publish in step 4.

### GitHub repository settings

- [ ] **Branch ruleset** on `master` (Settings -> Rules -> Rulesets): require a pull request with at least one review, require the CI status checks to pass, block force pushes, restrict deletions. Optionally require linear history and signed commits.
- [ ] **Code security and analysis** (Settings): enable Dependabot alerts, Dependabot security updates, secret scanning, push protection, and private vulnerability reporting.
- [ ] **Workflow permissions** (Settings -> Actions -> General): set the default `GITHUB_TOKEN` to read-only.
- [ ] **CodeQL**: either rely on `.github/workflows/codeql.yml`, or enable Code scanning "default setup" in the Security tab.
- [ ] **`release` environment** (Settings -> Environments -> New environment -> `release`): add yourself as a required reviewer so `publish.yml` waits for manual approval.

## 4. First publish (one time, manual)

Trusted publishing can only be configured on a package that already exists, so
publish v1.0.0 manually first.

```sh
npm publish --access public      # authenticated with the granular token + 2FA
```

After publishing, inspect the npm package page and verify the README, badges,
license, repository link, and tarball contents.

## 5. Configure trusted publishing

On npmjs.com -> the package -> Settings -> Trusted Publisher:

- [ ] Add a GitHub Actions publisher: owner `pauldeng`, repository `node-red-contrib-bullmq`, workflow filename `publish.yml` (case-sensitive), optional environment `release`.
- [ ] Set the package to "Require two-factor authentication and disallow tokens".
- [ ] Revoke the temporary granular token from step 3.

## 6. Subsequent releases (automated)

For every release after the first:

1. Bump the version and tag it (a signed tag is recommended):
   ```sh
   npm version <patch|minor|major>
   git push --follow-tags
   ```
2. Create a **GitHub Release** for the new tag. Publishing the `release` triggers `.github/workflows/publish.yml`.
3. Approve the `release` environment deployment when prompted.
4. The workflow publishes to npm over OIDC with provenance - no token needed.

Confirm `npm view @pauldeng/node-red-contrib-bullmq` shows the new version and
that the npm page displays the green provenance badge.

## 7. Node-RED Flow Library

The Flow Library indexes npm but submission is **manual** (since April 2020).
Scoped packages are fully supported and listed.

- [ ] First time: submit via the `+` button at <https://flows.nodered.org/add/node> using package `@pauldeng/node-red-contrib-bullmq`.
- [ ] For later versions: use the "request refresh" link on the package's library page (visible when logged in).

## 8. Optional

- [ ] Self-certify the OpenSSF Best Practices badge at <https://www.bestpractices.dev>.
