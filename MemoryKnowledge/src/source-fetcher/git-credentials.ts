import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface GitCredentials {
  username?: string;
  password?: string;
  private_key?: string;
  passphrase?: string;
}

export function parseGitCredentials(value: unknown, ssh: boolean): GitCredentials | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('credentials must be an object');
  const result: GitCredentials = {};
  for (const name of ['username', 'password', 'private_key', 'passphrase'] as const) {
    const field = (value as Record<string, unknown>)[name];
    if (field == null || field === '') continue;
    if (typeof field !== 'string' || field.includes('\0') || field.length > (name === 'private_key' ? 65536 : 4096)) {
      throw new Error(`Invalid credential field: ${name}`);
    }
    result[name] = field;
  }
  if (ssh && (result.username || result.password)) throw new Error('Use a private key for SSH authentication');
  if (!ssh && (result.private_key || result.passphrase)) throw new Error('Use username/password for HTTPS authentication');
  if (result.private_key && !/-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(result.private_key)) {
    throw new Error('Import a PEM or OpenSSH private key');
  }
  if (result.passphrase && !result.private_key) throw new Error('A passphrase requires a private key');
  return Object.keys(result).length ? result : undefined;
}

/** Secrets live outside indexed checkouts. Keep this directory in the persistent data volume. */
export class GitCredentialStore {
  private readonly dir: string;
  constructor(dataRoot: string) { this.dir = join(dataRoot, '_git_credentials'); }
  private path(serviceId: string, id: string): string {
    return join(this.dir, createHash('sha256').update(JSON.stringify([serviceId, id])).digest('hex') + '.enc');
  }
  private key(): Buffer {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, 'master.key');
    try { writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' }); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
    return readFileSync(path);
  }
  put(serviceId: string, id: string, credentials: GitCredentials): void {
    const key = this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    const path = this.path(serviceId, id);
    const tmp = path + '.' + randomBytes(8).toString('hex');
    try {
      writeFileSync(tmp, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, path);
    } finally { rmSync(tmp, { force: true }); }
  }
  get(serviceId: string, id: string): GitCredentials | undefined {
    let data: Buffer;
    try { data = readFileSync(this.path(serviceId, id)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw err; }
    const cipher = createDecipheriv('aes-256-gcm', this.key(), data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'));
  }
  delete(serviceId: string, id: string): void { rmSync(this.path(serviceId, id), { force: true }); }
}
