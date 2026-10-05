#!/usr/bin/env bash
# Checks the actions this repository's workflows use, one `uses:` line at a time.
#
# Without an argument: every reference is a commit SHA with the version it stands for in a comment
# (`owner/action@<sha> # v7.0.1`), and the SHA is the commit that tag v7.0.1 of owner/action points at. A SHA that
# belongs to no such tag, a tag that has moved since, a missing comment and a plain `@v7` all fail.
#
# With --advisories: GitHub's advisory database knows no vulnerability in the versions the comments name. Dependabot
# raises no alert for an action pinned by SHA, so this asks in its place. It trusts the comments; the first mode is
# what makes them true.
#
# Local actions (./…) and docker:// images are skipped. Needs git; --advisories needs gh and a token.
# Usage: .github/scripts/verify-pins.sh [--advisories]
set -euo pipefail

mode=pins
[[ ${1:-} == --advisories ]] && mode=advisories

mapfile -t files < <(git ls-files '.github/workflows/*.yml' '.github/workflows/*.yaml' 'action.yml' 'action.yaml' '*/action.yml' '*/action.yaml')
(( ${#files[@]} )) || { echo "no workflow files"; exit 0; }

uses='^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*["'\'']?([^[:space:]"'\''#@]+)@([^[:space:]"'\''#]+)["'\'']?[[:space:]]*(#[[:space:]]*([^[:space:]]+))?'
declare -A tag_commit asked
failed=0 count=0
fail() { echo "::error file=$1,line=$2::$3"; failed=1; }
# Three tries, so a network hiccup does not read as a broken pin.
retry() { local try; for try in 1 2 3; do "$@" && return 0; sleep $((try * 3)); done; return 1; }

# Read into an array first: git and gh inside the loop would otherwise eat the lines it is still to read.
mapfile -t found_uses < <(grep -n -H -E '^[[:space:]]*(-[[:space:]]*)?uses:' "${files[@]}")
for entry in "${found_uses[@]}"; do
  IFS=: read -r file line text <<<"$entry"
  [[ $text =~ $uses ]] || continue
  action=${BASH_REMATCH[2]} ref=${BASH_REMATCH[3]} version=${BASH_REMATCH[5]:-}
  [[ $action == ./* || $action == docker://* ]] && continue
  repo=$(cut -d/ -f1,2 <<<"$action")
  key="$repo $version"

  if [[ $mode == advisories ]]; then
    # One question per version; a line the first mode would fail has nothing to ask about.
    [[ $version =~ ^[A-Za-z0-9._-]+$ && ! -v asked[$key] ]] || continue
    asked[$key]=1
    count=$((count + 1))
    export ACTION_REPO=$repo
    found=$(retry gh api "advisories?ecosystem=actions&per_page=100&affects=$repo%40${version#v}" \
      --jq '.[] | "\(.ghsa_id) (\(.severity)), fixed in \([.vulnerabilities[] | select(.package.name | ascii_downcase == (env.ACTION_REPO | ascii_downcase)) | .first_patched_version // empty] | unique | join(", ") | if . == "" then "no version yet" else . end)"')
    while IFS= read -r advisory; do
      [[ -z $advisory ]] || fail "$file" "$line" "$repo $version has a known vulnerability: $advisory"
    done <<<"$found"
    continue
  fi

  if [[ ! $ref =~ ^[0-9a-f]{40}$ ]]; then
    fail "$file" "$line" "$action@$ref is not pinned to a commit SHA"
  elif [[ ! $version =~ ^[A-Za-z0-9._-]+$ ]]; then
    fail "$file" "$line" "$action@${ref:0:12} names no version in a comment, so the SHA cannot be checked"
  else
    if [[ ! -v tag_commit[$key] ]]; then
      # An annotated tag lists twice: the tag object, then the commit it points at as `^{}`. The commit is the last line.
      tag_commit[$key]=$(retry git ls-remote "https://github.com/$repo" "refs/tags/$version" "refs/tags/$version^{}" | tail -n 1 | cut -f1)
    fi
    if [[ -z ${tag_commit[$key]} ]]; then
      fail "$file" "$line" "$repo has no tag $version, so $action@${ref:0:12} cannot be checked"
    elif [[ ${tag_commit[$key]} != "$ref" ]]; then
      fail "$file" "$line" "$action@${ref:0:12} is not $version: that tag points at ${tag_commit[$key]:0:12}"
    else
      count=$((count + 1))
    fi
  fi
done

if [[ $mode == advisories ]]; then
  echo "advisory database asked about $count action version(s)"
else
  echo "$count action reference(s) match the tag they name"
fi
exit $failed
