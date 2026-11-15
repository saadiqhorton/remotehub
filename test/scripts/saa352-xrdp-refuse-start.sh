#!/bin/sh
# CI-only SAA-352 fixture: xrdp relays to Xvnc started with -AcceptSetDesktopSize=0, so every resize is refused.
# Never run on a user's computer.
set -e
sed -i 's/^autorun=.*/autorun=Xvnc/' /etc/xrdp/xrdp.ini; grep -q '^autorun=Xvnc' /etc/xrdp/xrdp.ini || sed -i 's/^\[Globals\]/[Globals]\nautorun=Xvnc/' /etc/xrdp/xrdp.ini
sed -i 's/^LogLevel=.*/LogLevel=DEBUG/' /etc/xrdp/xrdp.ini
# add the refusal flag to the Xvnc section of sesman.ini
sed -i '/^\[Xvnc\]/,/^\[/ s/^param=96$/param=96\nparam=-AcceptSetDesktopSize=0/' /etc/xrdp/sesman.ini
grep -n -A12 '^\[Xvnc\]' /etc/xrdp/sesman.ini
mkdir -p /run/xrdp && chown xrdp /run/xrdp 2>/dev/null || true
/usr/sbin/xrdp-sesman --nodaemon &
exec /usr/sbin/xrdp --nodaemon
