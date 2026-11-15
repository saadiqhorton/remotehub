#!/usr/bin/env bash
# Trusted orchestration only: never run this workflow for arbitrary PR authors.
# Guest steps receive no host mounts, Docker socket, GitHub token or repo secrets.
set -euo pipefail
mode=${1:?init, step, collect, or destroy}
name="rh-vm-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}-${GITHUB_JOB:?}"
owner="$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT:$GITHUB_JOB"
image="remotehub-ci/vm:$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"
state="$RUNNER_TEMP/$name"
case "$name" in rh-vm-[0-9]*-[0-9]*-*) ;; *) exit 1;; esac

owned() {
  test "$(docker inspect --format '{{index .Config.Labels "remotehub.ci.owner"}}' "$name")" = "$owner"
}
guest() {
  owned || return 1
  local address port
  address=$(docker port "$name" 2222/tcp)
  if ! [[ "$address" =~ ^127\.0\.0\.1:([0-9]+)$ ]]; then
    printf 'Unexpected guest port mapping: %s\n' "$address" >&2
    return 1
  fi
  port=${BASH_REMATCH[1]}
  ssh -F /dev/null -i "$state/key" -p "$port" -o IdentitiesOnly=yes \
    -o ForwardAgent=no -o BatchMode=yes -o ConnectTimeout=5 \
    -o ServerAliveInterval=30 -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="$state/known-hosts" ci@127.0.0.1 "$@"
}
guest_script() {
  guest 'cat > /ci/step.sh'
  # A background fixture must inherit a guest log, not the SSH channel. Execute
  # a file with closed stdin, as Actions does, so tools cannot consume the script.
  guest 'bash -c '\''bash -euo pipefail /ci/step.sh > /ci/step.log 2>&1 < /dev/null; result=$?; cat /ci/step.log; exit "$result"'\''' < /dev/null
}
destroy() {
  if docker container inspect "$name" >/dev/null 2>&1; then
    owned
    docker rm -f "$name"
  fi
  if docker container inspect "$name" >/dev/null 2>&1; then return 1; fi
  if docker image inspect "$image" >/dev/null 2>&1; then docker image rm "$image"; fi
  if test -f "$state/baseline-ids"; then
    local result=0 cid
    while read -r cid; do
      docker inspect --format '{{.Id}} {{.State.StartedAt}} {{.State.Running}}' "$cid"
    done < "$state/baseline-ids" > "$state/final-state"
    diff -u "$state/baseline-state" "$state/final-state" || result=$?
    rm -rf -- "$state"
    test "$result" -eq 0
    echo 'Existing host containers kept their identities/start times; guest cleanup PASS'
  fi
}

case "$mode" in
  init)
    test ! -e "$state"
    mkdir -m 700 "$state"
    trap 'status=$?; if test "$status" -ne 0; then if test -f "$state/hypervisor.log"; then tail -n 80 "$state/hypervisor.log"; fi; if test -f "$state/ssh.log"; then tail -n 10 "$state/ssh.log"; fi; destroy; fi; exit "$status"' EXIT
    docker ps -q > "$state/baseline-ids"
    while read -r cid; do
      docker inspect --format '{{.Id}} {{.State.StartedAt}} {{.State.Running}}' "$cid"
    done < "$state/baseline-ids" > "$state/baseline-state"
    ssh-keygen -q -t ed25519 -N '' -f "$state/key"
    docker build -t "$image" deploy/ci-vm
    docker run --rm -d --name "$name" --label "remotehub.ci.owner=$owner" \
      --device /dev/kvm --cap-drop ALL --security-opt no-new-privileges:true \
      --cpus 2 --memory 5g --pids-limit 256 \
      -p 127.0.0.1::2222 --env "VM_PUBLIC_KEY=$(cat "$state/key.pub")" "$image"
    docker logs --follow "$name" > "$state/hypervisor.log" 2>&1 &
    ready=0
    for i in $(seq 1 180); do
      if guest true 2>"$state/ssh.log"; then ready=1; break; fi
      if test "$(docker inspect --format '{{.State.Running}}' "$name")" != true; then
        docker logs "$name"; exit 1
      fi
      sleep 5
    done
    if test "$ready" -ne 1; then docker logs "$name"; exit 1; fi
    guest 'sudo cloud-init status --wait; sudo mkdir -p /work /ci /tmp/runner; sudo chown ci:ci /work /ci /tmp/runner; touch /ci/env /ci/summary'
    tar -C "$GITHUB_WORKSPACE" -cf - . | guest 'tar -xf - -C /work'
    guest_script <<'GUEST'
      sudo apt-get update
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y curl xz-utils ca-certificates git build-essential docker.io docker-compose-v2
      sudo systemctl enable --now docker
      sudo usermod -aG docker ci
      cd /tmp
      curl -fsS --retry 3 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o SHASUMS256.txt
      filename=$(awk '/node-v[0-9.]+-linux-x64\.tar\.xz$/ {print $2}' SHASUMS256.txt)
      test -n "$filename"
      curl -fsS --retry 3 "https://nodejs.org/dist/latest-v22.x/$filename" -o "$filename"
      grep " $filename$" SHASUMS256.txt | sha256sum --check -
      sudo tar -xJf "$filename" --strip-components=1 -C /usr/local
      node --version
      docker compose version
GUEST
    if test "${VM_RUST:-false}" = true; then
      guest 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal'
    fi
    # These are disposable fixture passwords, never repository or host secrets.
    python3 - <<'PY'
import os, secrets
with open(os.environ['GITHUB_ENV'], 'a') as output:
    for key, length in [('SSH_PASSWORD', 24), ('OWNER_PASSWORD', 24), ('RDP_PASSWORD', 24), ('VNC_PASSWORD', 8)]:
        value = secrets.token_hex(length // 2)
        print('::add-mask::' + value)
        output.write(key + '=' + value + '\n')
PY
    echo 'Disposable Ubuntu KVM guest ready; no host filesystem/socket is mounted'
    ;;
  step)
    # Quote only the explicit fixture variables; never forward the host environment.
    {
      relative=$(python3 -c 'import os; from pathlib import Path; print(Path.cwd().resolve().relative_to(Path(os.environ["GITHUB_WORKSPACE"]).resolve()))')
      printf 'cd %q\n' "/work/$relative"
      printf 'export HOME=/home/ci USER=ci LOGNAME=ci PATH=/home/ci/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n'
      printf 'export GITHUB_WORKSPACE=/work RUNNER_TEMP=/tmp/runner GITHUB_ENV=/ci/env GITHUB_STEP_SUMMARY=/ci/summary CI=true GITHUB_ACTIONS=true\n'
      for key in SSH_PORT SSH_PASSWORD OWNER_PASSWORD OUT VNC_ADDR VNC_PORT VNC_PASSWORD RDP_ADDR RDP_PORT RDP_USER RDP_PASSWORD; do
        if test -v "$key"; then printf 'export %s=%q\n' "$key" "${!key}"; fi
      done
      printf 'set -a\nsource /ci/env\nset +a\n'
      cat "${2:?GitHub step script}"
    } | guest_script
    ;;
  collect)
    {
      for key in SSH_PASSWORD OWNER_PASSWORD RDP_PASSWORD VNC_PASSWORD; do
        if test -v "$key"; then printf 'export %s=%q\n' "$key" "${!key}"; fi
      done
      cat <<'GUEST'
cd /work
mkdir -p desktop-logs
for name in xvfb xterm x11vnc; do
  if test -f "$HOME/$name.log"; then cp "$HOME/$name.log" desktop-logs/; fi
done
for log in /var/log/xrdp.log /var/log/xrdp-sesman.log; do
  if sudo test -f "$log"; then sudo cp "$log" desktop-logs/; fi
done
if test -d desktop-logs; then sudo chown -R ci:ci desktop-logs; fi
if test -d compose-acceptance-diagnostics; then sudo chown -R ci:ci compose-acceptance-diagnostics; fi
python3 - <<'PY'
import os
from pathlib import Path
passwords = [os.environ.get(key, '') for key in ('SSH_PASSWORD', 'OWNER_PASSWORD', 'RDP_PASSWORD', 'VNC_PASSWORD')]
for root in ('desktop-logs', 'compose-acceptance-diagnostics'):
    for path in Path(root).rglob('*'):
        if path.is_file() and not path.is_symlink():
            text = path.read_text(errors='replace')
            for password in passwords:
                if password:
                    text = text.replace(password, '(password removed)')
            path.write_text(text)
PY
GUEST
    } | guest_script
    # The extraction filter rejects links, devices and paths escaping the destination.
    guest 'cd /work; paths=(); for p in clean-install-shots compose-acceptance-shots compose-acceptance-diagnostics server.log ssh-server.log desktop-logs; do test ! -e "$p" || paths+=("$p"); done; tar -cf - "${paths[@]}" /ci/summary' > "$state/artifacts.tar"
    python3 deploy/ci-vm-artifacts.py "$state/artifacts.tar" "$GITHUB_WORKSPACE"
    cat "$GITHUB_WORKSPACE/ci/summary" >> "$GITHUB_STEP_SUMMARY"
    ;;
  destroy) destroy;;
  *) exit 1;;
esac
