#!/bin/sh
# Extracts commit <sha> of <worktree> into a new folder <dir>, for a reviewer to run tests and mutants in
# without touching <worktree>. The copy has no .git. Its node_modules links to the main checkout's when its
# package.json and package-lock.json are the same as the main checkout's apart from the package's own version;
# a copy whose commit has its own node_modules keeps it. <dir>'s parent folder must already exist, and <dir>
# must not lie inside any git checkout. Prints the copy's absolute path on stdout; the other messages go to stderr.
#   scripts/scratch-copy.sh <worktree> <sha> <dir>
set -eu
usage() { echo "usage: scripts/scratch-copy.sh <worktree> <sha> <dir>" >&2; exit 2; }
# Exits 0 when the JSON files $1 and $2 are the same once the package's own version is left out: the top-level one
# and the lockfile's packages[""] one. Exits 1 when they differ or a file cannot be read or parsed; node's message is
# hidden, since the caller reports the difference.
same_deps() {
  node -e '
    const load = (file) => {
      const json = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
      delete json.version;
      if (json.packages && json.packages[""]) delete json.packages[""].version;
      return JSON.stringify(json);
    };
    process.exitCode = load(process.argv[1]) === load(process.argv[2]) ? 0 : 1;
  ' "$1" "$2" 2>/dev/null
}
[ $# -eq 3 ] || usage
worktree=$1
sha=$2
dir=$3
# cd -P resolves symlinks and `..` in the parent, so the path checked is the path the copy is written to.
# CDPATH='' keeps cd from printing the path when the caller has CDPATH set; the trailing /. keeps a parent named - from meaning the previous folder.
parent=$(CDPATH='' cd -P -- "$(dirname -- "$dir")/." 2>/dev/null && pwd -P) || { echo "scratch-copy: the folder holding $dir does not exist; make it first" >&2; exit 1; }
phys=$parent/$(basename -- "$dir")
[ ! -e "$phys" ] || { echo "scratch-copy: $dir already exists; name a new folder" >&2; exit 1; }
git -C "$worktree" rev-parse --verify -q "$sha^{commit}" >/dev/null || { echo "scratch-copy: $sha is not a commit of $worktree" >&2; exit 1; }
main=$(dirname "$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)")
# git answers for every spelling of the folder (letter case, a /System/Volumes/Data prefix, a symlink), and across a
# mount point inside a checkout with GIT_DISCOVERY_ACROSS_FILESYSTEM.
if GIT_DISCOVERY_ACROSS_FILESYSTEM=1 git -C "$parent" rev-parse --git-dir >/dev/null 2>&1; then
  echo "scratch-copy: $dir is inside a git checkout; name a folder outside one" >&2
  exit 1
fi
archive=$(mktemp "$parent/.scratch-copy.XXXXXX")
trap 'rm -f "$archive"' EXIT
git -C "$worktree" archive "$sha" > "$archive" || { echo "scratch-copy: git archive failed for $sha" >&2; exit 1; }
mkdir "$phys"
# The shell opens both paths: GNU tar reads a backslash in its -C argument as an escape.
(cd -- "$phys" && tar -x -f -) < "$archive"
if [ ! -d "$main/node_modules" ]; then
  echo "scratch-copy: did not link node_modules: $main has none" >&2
# -e misses a link to nothing, which ln -sn would fail on; ln -sn would put the link inside a folder at that name.
elif [ -e "$phys/node_modules" ] || [ -L "$phys/node_modules" ]; then
  echo "scratch-copy: did not link node_modules: the commit already has node_modules" >&2
elif same_deps "$main/package.json" "$phys/package.json" && same_deps "$main/package-lock.json" "$phys/package-lock.json"; then
  ln -sn "$main/node_modules" "$phys/node_modules"
  echo "scratch-copy: linked node_modules to $main/node_modules" >&2
else
  echo "scratch-copy: did not link node_modules: package.json or package-lock.json differs from $main" >&2
fi
printf '%s\n' "$phys"
