# RemoteHub

This project is a Cross-platform browser-based remote access workspace with SSH terminal, SFTP files, guacd 
desktop access, and optional Rust agent/helper.

## Agent Rules

Always treat the source code as the source of truth. When working on the project, never make any assumptions or guess at stuff that you haven't directly verified from the code, by checking the UI, running tests, or running code. That must be done first to reduce mistakes in work.

## UI / Design System

Read `design-system/editorial-mono/AGENTS.md` before any visual change. The browser is plain ES modules in `public/js/`. Style `public/` from `tokens.css` and `public/css/app.css`.

## Trust

SSH passwords stay in memory for the login exchange only. Persisted secrets are the owner scrypt hash and confirmed host-key fingerprints, keyed by address and port. Read `server/ssh-bridge.js`, `server/auth.js`, and `server/store.js` before changing login, connect, or `data/`.

New HTTP routes and WebSocket upgrades call `originAllowed` in `server/app.js` before they touch a session.

## Capabilities

Read `server/capabilities.js` before adding or gating Terminal, Files, Desktop, or Agent. Unknown keys stay stored and inert; only a known boolean flag enables a surface. A host edit that omits `capabilities` leaves the stored object as it is (`server/store.js`).

## Surfaces

Read `public/js/session-surface.js` before adding a workspace tab.

## Tests

Cover new server behavior with a regression in `test/`, started from `test/helpers/app-harness.js`. Shell and SFTP cases also use `test/helpers/fake-ssh-server.js`.

## Commits

Always branch and open a PR to `main`. Run `docs/regression-checklist.md` in a real browser before asking for review.
