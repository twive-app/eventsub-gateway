# Releasing

For maintainers: how a version of the gateway gets from `dev` to a GitHub release and a Docker image. Everything below is
what the workflows in [`workflows/`](workflows) do – `release.yaml`, `docker-publish.yml`, `build.yaml` and
`lint.yaml`.

- [1. Versioning](#1-versioning)
- [2. Branches](#2-branches)
- [3. Creating a release](#3-creating-a-release)
- [4. Prereleases](#4-prereleases)
- [5. Automatic builds without a release](#5-automatic-builds-without-a-release)
- [6. When something goes wrong](#6-when-something-goes-wrong)
- [7. Hotfix](#7-hotfix)
- [8. Once, before the first release](#8-once-before-the-first-release)
- [9. Checklist](#9-checklist)

## 1. Versioning

[SemVer](https://semver.org). There are exactly two kinds of versions:

- **Releases:** `X.Y.Z`, tag `vX.Y.Z`
- **Prereleases:** `X.Y.Z-alpha.N`, `X.Y.Z-beta.N`, `X.Y.Z-rc.N`, tag `vX.Y.Z-beta.N` etc.

| Bump | When |
|---|---|
| **Major** | Breaking for apps or operators: a protocol change clients have to follow (new API version `v`, removed/renamed fields, opcodes or events, changed close code semantics), a removed or renamed environment variable, a changed default that changes behaviour, data in Redis that a downgrade can't read |
| **Minor** | Backwards compatible additions: new events, opcodes, fields or close codes, new optional environment variables, new endpoints |
| **Patch** | Fixes and internal changes without new behaviour for apps or operators (also dependency and base image updates) |

The version comes **only from the tag** – nobody bumps it by hand. `package.json` always keeps the placeholder
`"version": "0.0.0"` (the lint workflow fails otherwise); the release and publish workflows write the version of the tag
into `package.json` while building; the release workflow also keeps that state on a branch `release/vX.Y.Z`. Tags in any other format are rejected. Images built from
`dev` report the latest tag before them plus the commit, e.g. `1.2.3-dev.abc1234` (`0.0.0-dev.…` before the first
release); local builds report `0.0.0`.

## 2. Branches

Development happens on `dev`, releases are cut from `main`:

1. Open a pull request `dev` → `main`.
2. Wait for the checks: *Lint* (typecheck, ESLint, placeholder version, commit messages) and *Build* (both binaries
   compiled and smoke-tested against Redis).
3. Merge with a normal merge commit.

`main` gets no Docker image of its own – its releases become `vX.Y.Z` and `latest`. Every push to `dev` builds the
image `dev` (see [section 5](#5-automatic-builds-without-a-release)).

## 3. Creating a release

1. **Tag `main`** after the pull request `dev` → `main` is merged – the tag is the version (`v1.2.3`, or e.g.
   `v1.3.0-beta.1` for a prerelease):

   ```bash
   git switch main && git pull
   git tag -a v1.2.3 -m "v1.2.3"
   git push origin v1.2.3
   ```

2. **The *Release* workflow runs** (`release.yaml`, on every pushed tag `v*`):
   1. `bun install --frozen-lockfile` and `bun run typecheck`.
   2. Checks the tag format and writes its version into `package.json` – an invalid tag stops the run before anything
      is built.
   3. Creates the branch `release/v1.2.3` from the tagged commit and pushes it with the commit
      `ci(Release): bump version to 1.2.3` (the stamped `package.json`). The tag itself keeps pointing to the commit on
      `main` with `0.0.0`.
   4. Compiles `eventsub-gateway-linux-x64` (`bun-linux-x64-baseline`) and `eventsub-gateway-linux-arm64`
      and checks that `./eventsub-gateway-linux-x64 --version` prints `1.2.3`.
   5. Writes `checksum.txt` (SHA-256 of both binaries).
   6. Creates a **draft** release for the tag with the three files – marked as prerelease for `-alpha.N`, `-beta.N`
      and `-rc.N`.

3. **Review the draft** under *Releases*: the files are attached, the prerelease flag is right. Write the release notes
   – *Generate release notes* gives you the merged pull requests; group them into *Features* (`feat`) and *Fixes*
   (`fix`) and call out anything breaking or any new environment variable.

4. **Publish** the draft. The *Docker Publish* workflow (`docker-publish.yml`, `release: published`) checks out the
   tag and builds the image with its version for `linux/amd64` and `linux/arm64` with the tags
   - `v1.2.3`, and
   - `latest` – only if the release is not marked as prerelease.

5. **Verify:**

   ```bash
   docker run --rm ghcr.io/twive-app/eventsub-gateway:v1.2.3 --version    # 1.2.3
   docker run --rm ghcr.io/twive-app/eventsub-gateway:latest --version    # 1.2.3 (not for prereleases)
   ```

   and download a binary from the release: `sha256sum --check --ignore-missing checksum.txt`,
   `./eventsub-gateway-linux-x64 --version`.

## 4. Prereleases

A prerelease is a version with `-alpha.N`, `-beta.N` or `-rc.N` (`release.yaml` sets the prerelease flag of the draft
from it) – just tag e.g. `v1.3.0-beta.1`. `docker-publish.yml` follows the flag of the published release: a prerelease gets its own
tag (e.g. `v1.3.0-rc.1`) and the channel tag `alpha`, `beta` or `rc` (from `-alpha`, `-beta`, `-rc` in the tag), so
testers can follow e.g. `ghcr.io/twive-app/eventsub-gateway:beta` – never `latest`. The weekly rebuild
([section 5](#5-automatic-builds-without-a-release)) ignores prereleases – it rebuilds GitHub's *latest* release, and
the channel tags only move with the next prerelease of that channel.

## 5. Automatic builds without a release

| Trigger | Workflow | Result |
|---|---|---|
| Push to `dev` | `docker-publish.yml` | image `dev` with the version `<latest tag>-dev.<short sha>` |
| Sundays 03:00 UTC | `cleanup-images.yaml` | old untagged image versions removed, see [Cleanup](#cleanup) |
| Push to `main` / `dev`, pull requests | `build.yaml` | both binaries compiled and smoke-tested (`--version`, start, healthcheck, SIGTERM), uploaded as workflow artifacts – skipped when only docs changed; the check `Build` sums it up |
| Push to `main` / `dev`, pull requests | `lint.yaml` | typecheck, ESLint, placeholder version `0.0.0`; for pull requests also every commit message (commitlint) |
| Mondays 00:00 UTC | `docker-publish.yml` | the latest (non-prerelease) release rebuilt with fresh base images: tags `vX.Y.Z` and `latest` |

`skip docker` or `docker skip` in the message of the head commit of a push to `dev` skips the image build.
Releases and the weekly rebuild always build.

### Cleanup

`cleanup-images.yaml` runs every Sunday at 03:00 UTC and removes untagged image versions from GHCR that are older than
30 days and that no tagged image references – the earlier builds of `dev` and the images replaced by the
weekly release rebuild.

Every tagged image (releases, `latest`, `alpha`/`beta`/`rc`, `dev`) stays, including every manifest it
references. Images pulled **by digest** (`…@sha256:…`) of an old build stop working
after 30 days – pin release tags instead.

Run it by hand under *Actions* → *Cleanup images* → *Run workflow* with a different age (`days`) or as a dry run
(`dry_run`), which only lists what would be removed:

```bash
gh workflow run cleanup-images.yaml -f days=7 -f dry_run=true
```

Deleting needs the **Admin** role of this repository on the package: organisation → Packages → `gateway` → *Package
settings* → *Manage Actions access*. If the run fails with `403`, add the repository there with the role *Admin*.

## 6. When something goes wrong

**The *Release* workflow failed** (or produced a broken draft): fix the cause on `main` (or use a valid tag), then
remove everything the run created and tag again:

```bash
gh release delete v1.2.3 --yes              # the draft, if it was created
git push origin --delete release/v1.2.3     # the release branch, if it was pushed
git push origin --delete v1.2.3             # the remote tag
git tag -d v1.2.3                           # the local tag

git switch main && git pull
git tag -a v1.2.3 -m "v1.2.3"
git push origin v1.2.3
```

**The image build failed after publishing:** fix the cause, then re-run the failed *Docker Publish* run from the
Actions tab (it builds the tag of the release again).

**A published release is broken:** never overwrite it – don't move the tag, don't replace the files. Release a patch
version (`v1.2.4`) with the fix.

## 7. Hotfix

1. Fix via a pull request into `main` – directly, or through `dev` → `main` if `dev` has nothing that shouldn't be
   released yet.
2. Merge `main` back into `dev` (pull request `main` → `dev`) so the fix isn't lost.
3. Tag the patch version on `main` as in [section 3](#3-creating-a-release).

## 8. Once, before the first release

- **Make the package public:** after the first image push, GitHub → organisation → *Packages* → `gateway` → *Package
  settings* → *Change visibility* → *Public*. Otherwise `docker pull` needs a login.
- **Tag ruleset:** *Settings → Rules → Rulesets → New tag ruleset* for `v*` that restricts creations, updates and
  deletions, with maintainers as the only bypass – only they can start a release.
- **Branch rules:** require the checks *Typecheck & ESLint*, *Commit messages* and *Build* for `dev` and `main`. The
  *Release* workflow pushes `release/*` branches with the `GITHUB_TOKEN` – no ruleset may block creating them.

## 9. Checklist

- [ ] Pull request `dev` → `main` merged, all checks green
- [ ] `main` pulled locally, tag `vX.Y.Z` created and pushed
- [ ] *Release* workflow green, branch `release/vX.Y.Z` exists
- [ ] Draft has `eventsub-gateway-linux-x64`, `eventsub-gateway-linux-arm64`, `checksum.txt`; prerelease
  flag correct
- [ ] Release notes written (features, fixes, breaking changes, new variables)
- [ ] Draft published
- [ ] *Docker Publish* workflow green
- [ ] `docker run --rm ghcr.io/twive-app/eventsub-gateway:vX.Y.Z --version` prints the version (and `latest` for a
  stable release)
- [ ] Binary from the release: checksum ok, `--version` prints the version
- [ ] Hotfix only: `main` merged back into `dev`
