import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSourceFetcher } from './git-fetcher.js';
import { GitCredentialStore } from './git-credentials.js';

let dir: string;
let server: Server;
let url: string;
const previousCA = process.env.GIT_SSL_CAINFO;
const git = (...args: string[]) => execFileSync('git', args, { stdio: 'pipe' });
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cg-https-integration-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'server.key'), '-out', join(dir, 'server.crt'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'pipe' });
  process.env.GIT_SSL_CAINFO = join(dir, 'server.crt');
  git('init', '-b', 'main', join(dir, 'source'));
  writeFileSync(join(dir, 'source', 'hello.txt'), 'first');
  git('-C', join(dir, 'source'), 'add', '.');
  git('-C', join(dir, 'source'), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial');
  git('clone', '--bare', join(dir, 'source'), join(dir, 'repo.git'));
  server = createServer({ key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.crt')) }, (req, res) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('alice:local-test-token').toString('base64')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }); res.end(); return;
    }
    const requestUrl = new URL(req.url!, 'https://localhost');
    const child = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: dir, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: requestUrl.pathname, QUERY_STRING: requestUrl.search.slice(1), REQUEST_METHOD: req.method!, CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: 'alice' } });
    const chunks: Buffer[] = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.resume();
    req.pipe(child.stdin);
    child.on('close', () => {
      const output = Buffer.concat(chunks);
      const split = output.indexOf('\r\n\r\n');
      if (split < 0) { res.writeHead(500); res.end(); return; }
      for (const line of output.subarray(0, split).toString().split('\r\n')) {
        const colon = line.indexOf(':');
        if (line.startsWith('Status:')) res.statusCode = Number(line.slice(colon + 1).trim().split(' ')[0]);
        else res.setHeader(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      res.end(output.subarray(split + 4));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `https://localhost:${(server.address() as { port: number }).port}/repo.git`;
}, 15000);
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (previousCA === undefined) delete process.env.GIT_SSL_CAINFO; else process.env.GIT_SSL_CAINFO = previousCA;
  if (dir) rmSync(dir, { recursive: true, force: true });
});
it('clones a protected HTTPS repo and syncs using credentials reloaded from disk', async () => {
  const credentials = { username: 'alice', password: 'local-test-token' };
  const fetcher = new GitSourceFetcher({ ssrfCheck: false });
  const checkout = join(dir, 'checkout');
  new GitCredentialStore(dir).put('service', 'repo', credentials);
  const result = await fetcher.fetch(url, 'main', checkout, credentials);
  expect(result.version).toHaveLength(12);
  expect(readFileSync(join(checkout, 'hello.txt'), 'utf8')).toBe('first');
  expect(readFileSync(join(checkout, '.git/config'), 'utf8')).not.toContain(credentials.password);
  writeFileSync(join(dir, 'source', 'hello.txt'), 'second');
  git('-C', join(dir, 'source'), 'add', '.');
  git('-C', join(dir, 'source'), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'update');
  git('-C', join(dir, 'source'), 'push', join(dir, 'repo.git'), 'main');
  await fetcher.sync(url, 'main', checkout, new GitCredentialStore(dir).get('service', 'repo'));
  expect(readFileSync(join(checkout, 'hello.txt'), 'utf8')).toBe('second');
  await expect(fetcher.fetch(url, 'main', join(dir, 'bad'), { username: 'alice', password: 'wrong-token' })).rejects.toThrow('Git clone/fetch failed');
}, 20000);
