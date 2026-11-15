import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateAgentToken, hashAgentToken } from './agent-auth.js';
import { defaultCapabilities, normalizeCapabilities } from './capabilities.js';

export const STORE_VERSION = 2;

const EMPTY = () => ({ version: STORE_VERSION, owner: null, hosts: [], knownHosts: {} });

export function endpointKey(address, port) {
  return `${String(address).trim().toLowerCase()}:${port}`;
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'remotehub.json');
    this.data = EMPTY();
    this.writing = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const hosts = Array.isArray(parsed.hosts) ? parsed.hosts : [];
      this.data = { ...EMPTY(), ...parsed, hosts };
      // Migrate pre-capability (v1) hosts: every saved host is an SSH host, so it
      // gains the agentless baseline. Shape-driven and idempotent — only hosts whose
      // capabilities are missing or invalid are rewritten, and no other field is
      // touched, so no existing terminal host data is lost.
      const storedVersion = Number.isInteger(parsed.version) ? parsed.version : 0;
      let migrated = storedVersion < STORE_VERSION;
      for (const host of this.data.hosts) {
        if (!host || typeof host !== 'object' || Array.isArray(host)) continue;
        // SAA-302: desktop passwords are never stored; strip any left by older builds.
        if (host.desktop && typeof host.desktop === 'object' && 'password' in host.desktop) {
          delete host.desktop.password;
          migrated = true;
        }
        const capabilities = normalizeCapabilities(host.capabilities);
        // SAA-305: a host saved with desktop settings before protocol capabilities
        // existed offers that protocol.
        if (['vnc', 'rdp'].includes(host.desktop?.protocol)) capabilities.desktop[host.desktop.protocol] = true;
        if (JSON.stringify(host.capabilities) !== JSON.stringify(capabilities)) {
          host.capabilities = capabilities;
          migrated = true;
        }
      }
      this.data.version = Math.max(storedVersion, STORE_VERSION);
      if (migrated) await this.save();
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Could not read ${this.file}: ${err.message}`);
      await this.save();
    }
    return this;
  }

  // Writes are serialized and atomic (temp file + rename) so a crash can't truncate the data file.
  save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
        await fs.writeFile(tmp, snapshot, { mode: 0o600 });
        await fs.rename(tmp, this.file);
      });
    return this.writing;
  }

  get owner() {
    return this.data.owner;
  }

  async setOwner(owner) {
    this.data.owner = owner;
    await this.save();
  }

  listHosts() {
    return this.data.hosts.map((host) => ({
      ...host,
      knownHost: this.getKnownHost(host.address, host.port),
    }));
  }

  getHost(id) {
    return this.data.hosts.find((host) => host.id === id) || null;
  }

  async addHost(fields) {
    const now = new Date().toISOString();
    const { capabilities, ...rest } = fields ?? {};
    const host = {
      id: randomBytes(8).toString('hex'),
      ...rest,
      capabilities: normalizeCapabilities(capabilities ?? defaultCapabilities()),
      createdAt: now,
      updatedAt: now,
    };
    this.data.hosts.push(host);
    await this.save();
    return host;
  }

  async updateHost(id, fields) {
    const host = this.getHost(id);
    if (!host) return null;
    const { capabilities, ...rest } = fields ?? {};
    Object.assign(host, rest, { updatedAt: new Date().toISOString() });
    // Ordinary edits (the host dialog never sends capabilities) leave the stored
    // capabilities untouched; explicit capability updates are normalized first.
    if (capabilities !== undefined) host.capabilities = normalizeCapabilities(capabilities);
    await this.save();
    return host;
  }

  // SAA-302: per-host desktop settings (null removes them).
  async setDesktop(id, settings) {
    const host = this.getHost(id);
    if (!host) return null;
    if (settings) host.desktop = settings;
    else delete host.desktop;
    host.updatedAt = new Date().toISOString();
    await this.save();
    return host;
  }

  // SAA-304: RDP trust-on-first-use certificate pin. `pin` null clears it (owner reset).
  // A first-use pin never overwrites a different pin that landed meanwhile; the caller
  // gets `changed` and fails closed.
  async setDesktopCertPin(id, pin, { onlyIfUnset = false } = {}) {
    const host = this.getHost(id);
    if (!host?.desktop || host.desktop.protocol !== 'rdp') return { host: null, result: 'no-desktop' };
    const current = host.desktop.certPin ?? null;
    if (onlyIfUnset && current) return { host, result: current === pin ? 'match' : 'changed' };
    if (pin) { host.desktop.certPin = pin; host.desktop.certPinnedAt = new Date().toISOString(); }
    else { delete host.desktop.certPin; delete host.desktop.certPinnedAt; }
    host.updatedAt = new Date().toISOString();
    await this.save();
    return { host, result: pin ? 'pinned' : 'cleared' };
  }

  // SAA-306: last desktop discovery result (availability/port/reason per backend). Kept apart
  // from host.desktop so discovery can never touch the RDP certificate pin.
  async setDesktopDiscovery(id, discovery) {
    const host = this.getHost(id);
    if (!host) return null;
    if (discovery) host.desktopDiscovery = discovery;
    else delete host.desktopDiscovery; // null clears it (address changed)
    await this.save();
    return host;
  }

  // SAA-306: one atomic write for a desktop save: settings, capabilities and (optionally)
  // the owner's preference land together in a single save(), or not at all.
  // `clearDiscovery` drops host.desktopDiscovery in the same write (saved port changed).
  async saveDesktopChoice(id, { desktop, capabilities, preference, clearDiscovery = false }) {
    const host = this.getHost(id);
    if (!host) return null;
    const next = { desktop, capabilities: normalizeCapabilities(capabilities) };
    if (preference !== undefined) next.desktopPreference = preference;
    const before = { desktop: host.desktop, capabilities: host.capabilities, desktopPreference: host.desktopPreference, desktopDiscovery: host.desktopDiscovery, updatedAt: host.updatedAt };
    Object.assign(host, next, { updatedAt: new Date().toISOString() });
    if (clearDiscovery) delete host.desktopDiscovery;
    try {
      await this.save();
    } catch (err) {
      Object.assign(host, before);
      if (before.desktopPreference === undefined) delete host.desktopPreference;
      if (before.desktopDiscovery === undefined) delete host.desktopDiscovery;
      throw err;
    }
    return host;
  }

  async removeHost(id) {
    const before = this.data.hosts.length;
    this.data.hosts = this.data.hosts.filter((host) => host.id !== id);
    if (this.data.hosts.length === before) return false;
    await this.save();
    return true;
  }

  // One long-lived credential per host. The raw token is returned once and never stored.
  async issueAgentCredential(id) {
    const host = this.getHost(id);
    if (!host) return null;
    const token = generateAgentToken();
    host.agentCredential = {
      id: randomBytes(8).toString('hex'),
      tokenHash: hashAgentToken(token),
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    host.updatedAt = new Date().toISOString();
    await this.save();
    return { host, token };
  }

  async revokeAgentCredential(id) {
    const host = this.getHost(id);
    if (!host?.agentCredential) return null;
    if (!host.agentCredential.revokedAt) {
      host.agentCredential.revokedAt = new Date().toISOString();
      host.updatedAt = new Date().toISOString();
      await this.save();
    }
    return host;
  }

  findAgentCredential(hostId) {
    const host = this.getHost(hostId);
    return host?.agentCredential || null;
  }

  getKnownHost(address, port) {
    return this.data.knownHosts[endpointKey(address, port)] || null;
  }

  async setKnownHost(address, port, { keyType, fingerprint }) {
    this.data.knownHosts[endpointKey(address, port)] = {
      keyType,
      fingerprint,
      addedAt: new Date().toISOString(),
    };
    await this.save();
  }

  async forgetKnownHost(address, port) {
    const key = endpointKey(address, port);
    if (!(key in this.data.knownHosts)) return false;
    delete this.data.knownHosts[key];
    await this.save();
    return true;
  }
}
