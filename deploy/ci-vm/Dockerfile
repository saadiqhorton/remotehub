# Hypervisor only. Repository code and nested Docker run inside the KVM guest.
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl qemu-system-x86 qemu-utils cloud-image-utils \
    && rm -rf /var/lib/apt/lists/* && mkdir /vm
COPY boot.sh /usr/local/bin/boot-ci-vm
ENTRYPOINT ["timeout", "--signal=TERM", "--kill-after=30s", "70m", "bash", "/usr/local/bin/boot-ci-vm"]
