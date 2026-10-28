# Updating to a newer upstream release

[Back to the fork overview](README.md).

The fork's `main` is upstream's history up to a release tag, followed by the six patch commits and the documentation
commits. To move to a newer upstream release, replay those commits onto the new tag.

## Steps

1. Add upstream as a remote, once:

   ```
   git remote add upstream https://github.com/Nystik-gh/ignis.git
   ```

2. Fetch upstream's branches and tags:

   ```
   git fetch upstream --tags
   ```

3. Choose the new release tag, `v<ignis>+obsidian.<x.y.z>`, for example from `git tag --sort=-creatordate | head`.
   The tag names the Obsidian version the release is pinned to.

4. Keep a branch at the current state, to compare and to fall back to:

   ```
   git branch fork-v0.8.18 main
   ```

5. Replay the fork's commits onto the new tag:

   ```
   git checkout main
   git rebase --onto <new tag> v0.8.18+obsidian.1.14.4 main
   ```

6. Resolve conflicts commit by commit. The files most likely to conflict, because the patches change upstream code in
   them:

   | File | Patches |
   | --- | --- |
   | `packages/shim/src/init.js` | 0001, 0003, 0004 |
   | `packages/shim/src/loader.js` | 0003, 0004, 0005 |
   | `apps/ignis-server/server/index.js` | 0002, 0003, 0006 |
   | `apps/ignis-server/server/routes/fs.js` | 0003 |
   | `packages/server-core/src/errors.js`, `packages/server-core/src/index.js` | 0003 |
   | `packages/shim/src/fs/promises.js`, `packages/shim/src/fs/indexer-prefetch.js` | 0004 |
   | `apps/ignis-server/server/settings.js`, `routes/settings.js`, `cache/crawl.js` | 0004 |
   | `packages/shim/build.js`, `packages/ui/build.js` | 0005 |
   | `README.md` | The fork notice at the top |

   After fixing a file: `git add <file>`, then `git rebase --continue`. If upstream has made a patch unnecessary,
   drop that commit with `git rebase --skip` and update its page in `docs/fork/`.

7. Build and test:

   ```
   npm ci
   npm run build
   npm run lint
   npm test
   ```

8. Update the documentation:
   - `README.md`: the release named in "About this fork";
   - `docs/fork/README.md`: the base release and commit, and the patch commit hashes (`git log --oneline <new tag>..main`);
   - `docs/fork/building.md`: the Obsidian version in the download URL and `.obsidian-version`;
   - each patch page whose files or behaviour changed.

9. Push. The rebase rewrote `main`, so a plain push is refused:

   ```
   git push --force-with-lease origin main
   ```

10. Regenerate the patch files that Ignis Control keeps in its `patches/` folder. For each of the six patch commits
    `<commit>`, in order, write its diff under Ignis Control's name for it:

    ```
    git diff <commit>~1 <commit> > <ignis-control>/patches/0001-local-plugins-guard.patch
    ```

    The names are `0001-local-plugins-guard.patch`, `0002-listen-host.patch`, `0003-diagnostics.patch`,
    `0004-mobile.patch`, `0005-startup.patch` and `0006-relay.patch`. Then update the base tag in Ignis Control's
    `patches/README.md`.

## After updating

Installations that cloned the fork must take the rewritten history:

```
git fetch
git reset --hard origin/main
npm ci
npm run build
```

`git reset --hard` discards local changes in that clone.
