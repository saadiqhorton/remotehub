# Changelog

## 0.1.0 — first public release

- **Terminal**: SSH sessions in tabs with host-key pinning on first connect.
- **Files**: SFTP browsing, recursive name search, viewing, upload, download, rename, and delete.
- **Desktop**: VNC and RDP in the browser through a pinned guacd build, with RDP certificate pinning,
  automatic resize fallback, reconnect, and remote sound.
- **Agent**: optional Rust agent (persistent service or temporary helper) for live file events and
  desktop sound on Linux, macOS, and Windows, installable from RemoteHub with one click.
- **MCP**: OAuth-protected remote MCP endpoint (authorization code + PKCE, dynamic client
  registration) exposing host listing, file read/write, and opt-in Windows command execution on
  owner-selected connected computers.
- **Deploy**: one-command Docker Compose stack, plus Caddy and nginx reverse-proxy configs.
