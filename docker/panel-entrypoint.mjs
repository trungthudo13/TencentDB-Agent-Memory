import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const configPath = process.env.METADATA_INSTANCES_CONFIG;
mkdirSync('/data/config', { recursive: true });
writeFileSync(configPath, JSON.stringify({ instances: [{
  id: 'default',
  name: 'default',
  gateway_endpoint: 'http://memory:8420',
  api_key: process.env.MEMORY_CORE_GATEWAY_API_KEY || 'local',
}] }), { mode: 0o600 });
const child = spawn(process.execPath, ['--import', 'tsx/esm', 'src/index.ts'], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 1));
