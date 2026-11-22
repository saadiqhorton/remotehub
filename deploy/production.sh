#!/usr/bin/env bash
set -euo pipefail

repo_path=$(git rev-parse --show-toplevel)
cd "$repo_path"

branch_name=$(git branch --show-current)
if [[ "$branch_name" != "main" ]]; then
  printf 'Refusing production deploy from branch %s; switch to main first.\n' "${branch_name:-detached HEAD}" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  printf 'Refusing production deploy from a dirty checkout. Commit or discard the changes first.\n' >&2
  exit 1
fi

git fetch --quiet origin main
local_commit=$(git rev-parse HEAD)
remote_commit=$(git rev-parse origin/main)
if [[ "$local_commit" != "$remote_commit" ]]; then
  printf 'Refusing production deploy: local main is %s but origin/main is %s. Fast-forward main first.\n' "$local_commit" "$remote_commit" >&2
  exit 1
fi

printf 'Deploying RemoteHub main at %s with Compose project remote-hub.\n' "$local_commit"
docker compose -p remote-hub up --build --detach --wait
