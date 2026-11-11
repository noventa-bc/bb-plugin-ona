#!/bin/sh
# Extracts commit <sha> of <worktree> into a new folder <dir>, for a reviewer to run tests and mutants in
# without touching <worktree>. The copy has no .git. Its node_modules links to the main checkout's when its
# package.json and package-lock.json match the main checkout's. <dir>'s parent folder must already exist, and
# <dir> must not lie inside any git checkout. Prints the copy's absolute path on stdout; the other messages go
# to stderr.
#   scripts/scratch-copy.sh <worktree> <sha> <dir>
set -eu
usage() { echo "usage: scripts/scratch-copy.sh <worktree> <sha> <dir>" >&2; exit 2; }
[ $# -eq 3 ] || usage
worktree=$1
sha=$2
dir=$3
# cd -P resolves symlinks and `..` in the parent, so the path checked is the path the copy is written to.
# CDPATH='' keeps cd from printing the path when the caller has CDPATH set.
parent=$(CDPATH='' cd -P -- "$(dirname -- "$dir")" 2>/dev/null && pwd -P) || { echo "scratch-copy: the folder holding $dir does not exist; make it first" >&2; exit 1; }
phys=$parent/$(basename -- "$dir")
[ ! -e "$phys" ] || { echo "scratch-copy: $dir already exists; name a new folder" >&2; exit 1; }
git -C "$worktree" rev-parse --verify -q "$sha^{commit}" >/dev/null || { echo "scratch-copy: $sha is not a commit of $worktree" >&2; exit 1; }
main=$(dirname "$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)")
# git answers for every spelling of the folder: letter case, a /System/Volumes/Data prefix, a symlink.
if git -C "$parent" rev-parse --git-dir >/dev/null 2>&1; then
  echo "scratch-copy: $dir is inside a git checkout; name a folder outside one" >&2
  exit 1
fi
archive=$(mktemp "$parent/.scratch-copy.XXXXXX")
trap 'rm -f "$archive"' EXIT
git -C "$worktree" archive "$sha" > "$archive" || { echo "scratch-copy: git archive failed for $sha" >&2; exit 1; }
mkdir "$phys"
tar -x -C "$phys" -f "$archive"
if [ ! -d "$main/node_modules" ]; then
  echo "scratch-copy: did not link node_modules: $main has none" >&2
elif cmp -s "$main/package.json" "$phys/package.json" && cmp -s "$main/package-lock.json" "$phys/package-lock.json"; then
  ln -sn "$main/node_modules" "$phys/node_modules"
  echo "scratch-copy: linked node_modules to $main/node_modules" >&2
else
  echo "scratch-copy: did not link node_modules: package.json or package-lock.json differs from $main" >&2
fi
echo "$phys"
