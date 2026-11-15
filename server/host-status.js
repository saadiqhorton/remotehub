// Live agent/helper presence per host (SAA-300).
//
// Three kinds of connection can vouch for a host, all of them live and in memory
// (nothing here is ever written to disk):
//   - 'registered': a persistent agent connected outbound to /ws/agent (SAA-296)
//   - 'local':      a persistent agent reached on the host's loopback port by a
//                   Files session (SAA-298)
//   - 'helper':     a temporary helper started by a Files session (SAA-299)
// Each one is attached with what its hello reported and detached when it goes
// away; views merge them with the host's agentless baseline.

import { EventEmitter } from 'node:events';
import { mergeCapabilities, sanitizeReportedCapabilities } from './capabilities.js';

const MODES = new Set(['persistent', 'temporary']);
const SOURCES = new Set(['registered', 'local', 'helper']);
const SHORT = /^[A-Za-z0-9._+-]{1,64}$/;

const short = (value) => (typeof value === 'string' && SHORT.test(value) ? value : null);

/** Turn an agent hello frame into a report holding only known, bounded fields. */
export function reportFromHello(hello, source) {
  const frame = hello && typeof hello === 'object' ? hello : {};
  const system = frame.system && typeof frame.system === 'object' ? frame.system : {};
  return {
    source: SOURCES.has(source) ? source : 'local',
    mode: MODES.has(frame.mode) ? frame.mode : null,
    version: short(frame.version),
    os: short(system.os),
    arch: short(system.arch),
    capabilities: sanitizeReportedCapabilities(frame.capabilities),
  };
}

export class HostStatus extends EventEmitter {
  constructor() {
    super();
    this.hosts = new Map(); // hostId -> Map(key -> report)
  }

  /** Record a live connection; returns a function that removes it (idempotent). */
  attach(hostId, key, report) {
    if (!this.hosts.has(hostId)) this.hosts.set(hostId, new Map());
    this.hosts.get(hostId).set(key, { ...report, since: new Date().toISOString() });
    this.emit('change', hostId);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.detach(hostId, key);
    };
  }

  detach(hostId, key) {
    const reports = this.hosts.get(hostId);
    if (!reports?.delete(key)) return;
    if (!reports.size) this.hosts.delete(hostId);
    this.emit('change', hostId);
  }

  reports(hostId) {
    return [...(this.hosts.get(hostId)?.values() ?? [])];
  }

  /** Effective view for one host: merged capabilities, provenance and agent summary. */
  view(host) {
    return mergeCapabilities(host?.capabilities, this.reports(host?.id));
  }
}
