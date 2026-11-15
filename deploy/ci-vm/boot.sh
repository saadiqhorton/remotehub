#!/usr/bin/env bash
set -euo pipefail
cd /vm
base=https://cloud-images.ubuntu.com/noble/current
curl --fail --silent --show-error --retry 3 "$base/SHA256SUMS" -o SHA256SUMS
curl --fail --silent --show-error --retry 3 "$base/noble-server-cloudimg-amd64.img" -o noble-server-cloudimg-amd64.img
grep ' \*\?noble-server-cloudimg-amd64.img$' SHA256SUMS | sha256sum --check -
mv noble-server-cloudimg-amd64.img disk.qcow2
qemu-img resize disk.qcow2 30G
cat > user-data <<EOF
#cloud-config
users:
  - name: ci
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${VM_PUBLIC_KEY:?}
ssh_pwauth: false
disable_root: true
EOF
printf 'instance-id: remotehub-ci\nlocal-hostname: remotehub-ci\n' > meta-data
cloud-localds seed.iso user-data meta-data
# Slirp provides guest networking without configuring any host bridge/firewall.
# Only the guest SSH port is forwarded; Docker publishes it on host loopback.
exec qemu-system-x86_64 -accel kvm -cpu host -smp 2 -m 4096 \
  -nographic -no-reboot \
  -drive file=disk.qcow2,if=virtio,format=qcow2 \
  -drive file=seed.iso,if=virtio,format=raw,readonly=on \
  -netdev user,id=net0,hostfwd=tcp:0.0.0.0:2222-:22 \
  -device virtio-net-pci,netdev=net0
