import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeGraphService } from './code-graph-service.js';
import { BuildQueue } from './build-queue.js';
import type { IKnowledgeStore, CodeGraphRow } from './types.js';
import { GitCredentialStore } from '../source-fetcher/git-credentials.js';

it('keeps credentials out of metadata and retries existing failed repos with newly supplied credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cg-service-test-'));
  let row: CodeGraphRow | null = null;
  const store = {
    createCodeGraph: vi.fn((params) => {
      if (row) return { row, existed: true };
      row = { ...params, code_graph_id: 'cg-test', status: 'pending', version: 1 } as CodeGraphRow;
      return { row, existed: false };
    }),
    getCodeGraph: () => row,
    getCodeGraphById: () => row,
    updateCodeGraphStatus: (_service: string, _id: string, patch: object) => { Object.assign(row!, patch); },
    deleteCodeGraph: () => { row = null; return true; },
    appendCodeGraphAudit: vi.fn(),
  };
  const queue = new BuildQueue();
  const worker = vi.fn(async (ctx) => {
    if (!ctx.credentials) throw new Error('Authentication required');
    return {};
  });
  try {
    const service = new CodeGraphService({ dataRoot: dir, store: store as unknown as IKnowledgeStore, worker, queue });
    const params = { service_id: 's', team_id: 't', repo_url: 'https://example.com/repo.git', branch: 'main' };
    service.create(params);
    await queue.onIdle();
    expect(service.get('s', 't', 'cg-test')?.status).toBe('failed');
    const credentials = { username: 'alice', password: 'test-token' };
    service.create({ ...params, credentials });
    await queue.onIdle();
    expect(worker).toHaveBeenLastCalledWith(expect.objectContaining({ credentials }));
    expect(service.get('s', 't', 'cg-test')?.status).toBe('ready');
    expect(store.createCodeGraph).toHaveBeenLastCalledWith(params);
    expect(JSON.stringify(row)).not.toContain('test-token');
    const restarted = new CodeGraphService({ dataRoot: dir, store: store as unknown as IKnowledgeStore, worker, queue });
    restarted.sync('s', 't', 'cg-test');
    await queue.onIdle();
    expect(worker).toHaveBeenLastCalledWith(expect.objectContaining({ credentials }));
    restarted.delete('s', 't', 'cg-test');
    expect(new GitCredentialStore(dir).get('s', 'cg-test')).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
