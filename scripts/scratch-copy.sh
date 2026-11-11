#!/bin/sh
# Extracts commit <sha> of <worktree> into a new folder <dir>, for a reviewer to run tests and mutants in
# without touching <worktree>. The copy has no .git. Its node_modules links to the main checkout's when its
# package.json and package-lock.json match the main checkout's. Prints the copy's absolute path on stdout;
# the other messages go to stderr.
#   scripts/scratch-copy.sh <worktree> <sha> <dir>
set -eu
[ $# -eq 3 ] || { echo "usage: scripts/scratch-copy.sh <worktree> <sha> <dir>" >&2; exit 2; }
worktree=$1
sha=$2
dir=$3
[ ! -e "$dir" ] || { echo "scratch-copy: $dir already exists; name a new folder" >&2; exit 1; }
git -C "$worktree" rev-parse --verify -q "$sha^{commit}" >/dev/null || { echo "scratch-copy: $sha is not a commit of $worktree" >&2; exit 1; }
mkdir -p "$dir"
git -C "$worktree" archive "$sha" | tar -x -C "$dir"
dir=$(cd "$dir" && pwd)
main=$(dirname "$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)")
if [ ! -d "$main/node_modules" ]; then
  echo "scratch-copy: did not link node_modules: $main has none" >&2
elif cmp -s "$main/package.json" "$dir/package.json" && cmp -s "$main/package-lock.json" "$dir/package-lock.json"; then
  ln -s "$main/node_modules" "$dir/node_modules"
  echo "scratch-copy: linked node_modules to $main/node_modules" >&2
else
  echo "scratch-copy: did not link node_modules: package.json or package-lock.json differs from $main" >&2
fi
echo "$dir"
