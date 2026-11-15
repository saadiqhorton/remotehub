# CI-only SAA-352 fixture: xrdp relaying to an Xvnc that refuses every resize ("Resize is administratively prohibited").
# Never run on a user's computer.
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xrdp tigervnc-standalone-server xterm dbus-x11 ca-certificates openssl && rm -rf /var/lib/apt/lists/*
ARG RDP_PASSWORD=Ci-rdp-pass-1
RUN useradd -m -s /bin/bash rdpci && echo "rdpci:${RDP_PASSWORD}" | chpasswd \
 && printf '#!/bin/sh\nexec xterm -geometry 120x40+0+0 -bg darkgreen -fg white\n' > /home/rdpci/.xsession \
 && chmod 755 /home/rdpci/.xsession && chown rdpci:rdpci /home/rdpci/.xsession && adduser xrdp ssl-cert
COPY saa352-xrdp-refuse-start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 3389
CMD ["/start.sh"]
