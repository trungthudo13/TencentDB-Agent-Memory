import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const state = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv, operation: undefined as undefined | (() => void) }));
vi.mock('simple-git', () => ({
  default: () => ({
    env(env: NodeJS.ProcessEnv) { state.env = env; return this; },
    async clone() { state.operation?.(); }, async fetch() { state.operation?.(); },
    async reset() {}, async clean() {}, async revparse() { return '1234567890abcdef'; },
  }),
  ResetMode: { HARD: 'hard' }, CleanOptions: { FORCE: 'f', RECURSIVE: 'd' },
}));
import { GitSourceFetcher } from './git-fetcher.js';

beforeEach(() => { state.env = {}; state.operation = undefined; });
describe('Git authentication', () => {
  it('accepts HTTPS, SCP and ssh URLs; rejects unsafe protocols and embedded credentials', () => {
    const fetcher = new GitSourceFetcher();
    for (const url of ['https://github.com/org/repo.git', 'git@github.com:org/repo.git', 'ssh://git@github.com:2222/org/repo.git']) expect(() => fetcher.validate(url)).not.toThrow();
    for (const url of ['http://github.com/r.git', 'file:///tmp/repo', 'https://user:secret@github.com/r', 'git@127.0.0.1:r.git', 'ssh://git@localhost/r', 'ssh://-oProxyCommand=evil@github.com/r']) expect(() => fetcher.validate(url)).toThrow();
  });
  it('provides HTTPS username/token through askpass during clone and sync, then removes helper', async () => {
    const fetcher = new GitSourceFetcher();
    const credentials = { username: 'alice', password: 'token-$`"-secret' };
    let helper = '';
    state.operation = () => {
      helper = state.env.GIT_ASKPASS!;
      expect(execFileSync(helper, ['Username for https://example.com'], { env: state.env, encoding: 'utf8' }).trim()).toBe(credentials.username);
      expect(execFileSync(helper, ['Password for https://example.com'], { env: state.env, encoding: 'utf8' }).trim()).toBe(credentials.password);
      expect(readFileSync(helper, 'utf8')).not.toContain(credentials.password);
      expect(state.env.GIT_TERMINAL_PROMPT).toBe('0');
    };
    await fetcher.fetch('https://example.com/repo.git', 'main', '/tmp/unused', credentials);
    expect(existsSync(helper)).toBe(false);
    await fetcher.sync('https://example.com/repo.git', 'main', '/tmp/unused', credentials);
    expect(existsSync(helper)).toBe(false);
  });
  it('uses restricted temporary SSH keys and removes them even on failure without leaking secrets', async () => {
    const fetcher = new GitSourceFetcher();
    const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-secret\n-----END OPENSSH PRIVATE KEY-----';
    let keyPath = '';
    state.operation = () => {
      keyPath = /-i '([^']+)'/.exec(state.env.GIT_SSH_COMMAND!)![1];
      expect(readFileSync(keyPath, 'utf8')).toBe(privateKey + '\n');
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(state.env.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=accept-new');
      expect(state.env.GIT_SSH_COMMAND).toContain('PasswordAuthentication=no');
      expect(state.env.GIT_SSH_COMMAND).toContain('KbdInteractiveAuthentication=no');
      expect(execFileSync(state.env.SSH_ASKPASS!, ['Enter passphrase'], { env: state.env, encoding: 'utf8' }).trim()).toBe('pass-secret');
      throw new Error(privateKey);
    };
    await expect(fetcher.fetch('git@example.com:org/repo.git', 'main', '/tmp/unused', { private_key: privateKey, passphrase: 'pass-secret' })).rejects.toThrow(/^Git clone\/fetch failed/);
    expect(existsSync(keyPath)).toBe(false);
  });
  it('does not inject HTTP credentials when left blank', async () => {
    await new GitSourceFetcher().fetch('https://example.com/repo.git', 'main', '/tmp/unused');
    expect(state.env.CG_GIT_PASSWORD).toBeUndefined();
  });
});
