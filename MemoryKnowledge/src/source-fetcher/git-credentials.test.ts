import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitCredentialStore, parseGitCredentials } from './git-credentials.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('repository credentials', () => {
  it('are optional, validates transport and never includes secret values in errors', () => {
    expect(parseGitCredentials(undefined, true)).toBeUndefined();
    expect(parseGitCredentials({}, false)).toBeUndefined();
    expect(parseGitCredentials({ username: 'git', password: 'token' }, false)).toEqual({ username: 'git', password: 'token' });
    expect(() => parseGitCredentials({ password: 'secret' }, true)).toThrow('private key');
    expect(() => parseGitCredentials({ private_key: 'secret' }, false)).toThrow('username/password');
    expect(() => parseGitCredentials({ private_key: 'secret' }, true)).toThrow('PEM or OpenSSH');
    expect(() => parseGitCredentials({ password: 'a\0b' }, false)).toThrow('Invalid credential');
  });
  it('encrypts on disk, survives restart, isolates tenants, detects tampering, and deletes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-vault-test-')); dirs.push(dir);
    const vault = new GitCredentialStore(dir);
    const credentials = { username: 'alice', password: 'test-secret-password' };
    vault.put('service-a', 'repo-id', credentials);
    const path = join(dir, '_git_credentials');
    const encrypted = join(path, readdirSync(path).find(name => name.endsWith('.enc'))!);
    expect(readFileSync(encrypted).includes(Buffer.from(credentials.password))).toBe(false);
    expect(statSync(encrypted).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, 'master.key')).mode & 0o777).toBe(0o600);
    const restarted = new GitCredentialStore(dir);
    expect(restarted.get('service-a', 'repo-id')).toEqual(credentials);
    expect(restarted.get('service-b', 'repo-id')).toBeUndefined();
    const damaged = readFileSync(encrypted); damaged[damaged.length - 1] ^= 1; writeFileSync(encrypted, damaged);
    expect(() => restarted.get('service-a', 'repo-id')).toThrow();
    restarted.delete('service-a', 'repo-id');
    expect(restarted.get('service-a', 'repo-id')).toBeUndefined();
  });
});
