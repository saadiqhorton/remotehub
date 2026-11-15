export class ValidationError extends Error {}

const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:.]+$/i;
const USERNAME = /^[^\s:@/\\]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function text(value, label, max) {
  if (typeof value !== 'string') throw new ValidationError(`${label} is required.`);
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError(`${label} is required.`);
  if (trimmed.length > max) throw new ValidationError(`${label} must be ${max} characters or fewer.`);
  if (CONTROL.test(trimmed)) throw new ValidationError(`${label} contains invalid characters.`);
  return trimmed;
}

export function validateAddress(value) {
  const address = text(value, 'Address', 253).replace(/^\[(.*)\]$/, '$1');
  const ok = IPV4.test(address) || HOSTNAME.test(address) || (address.includes(':') && IPV6.test(address));
  if (!ok) throw new ValidationError('Address must be a computer name or IP address, e.g. 192.168.1.20 or nas.local.');
  return address;
}

export function validatePort(value) {
  const port = value === undefined || value === null || value === '' ? 22 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError('Port must be a number between 1 and 65535.');
  }
  return port;
}

export function validateHost(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Computer details are required.');
  const username = text(body.username, 'Username', 64);
  if (!USERNAME.test(username)) throw new ValidationError('Username cannot contain spaces, @, :, or slashes.');
  return {
    name: text(body.name, 'Name', 64),
    address: validateAddress(body.address),
    port: validatePort(body.port),
    username,
  };
}

export function validateOwnerPassword(value) {
  if (typeof value !== 'string' || value.length < 10) {
    throw new ValidationError('Choose a password with at least 10 characters.');
  }
  if (value.length > 256) throw new ValidationError('Password must be 256 characters or fewer.');
  return value;
}
