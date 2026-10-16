/**
 * VDB 测试残留库清理（**破坏性操作，需显式确认**）。
 *
 * 背景：实例集合数已达上限 1500/1500，无法新建库做真机验证。
 * 本脚本只回收自动化 e2e 生成的一次性库，为新建验证库腾出空间。
 *
 * 安全设计（删除操作，宁可少删也不误删）：
 *   1. **单一前缀白名单**：只删`memory-tdai-test-` 开头的库，硬编码在
 *      ALLOWED_PREFIX，不接受外部参数覆盖。
 *   2. **黑名单二次否决**：即使命中前缀，只要落在 PROTECTED 里也跳过。
 *   3. **默认 dry-run**：不带 `--confirm` 只打印将删什么，不动数据。
 *   4. 逐个删除+ 失败不中断，最后汇总，便于定位。
 *
 * 用法：
 *   node --import tsx scripts/cleanup-vdb-test-dbs.ts            # dry-run
 *   node --import tsx scripts/cleanup-vdb-test-dbs.ts --confirm   # 真正删除
 */
import { TcvdbClient } from "../src/core/store/tcvdb/client.js";

const VDB_URL = process.env.VDB_URL;
const VDB_API_KEY = process.env.VDB_API_KEY;

if (!VDB_URL || !VDB_API_KEY) {
  console.error("VDB_URL / VDB_API_KEY environment variables are required");
  process.exit(2);
}

/**
 * 唯一允许删除的库名前缀 —— 硬编码，不可通过参数/环境变量修改。
 * 这些库由自动化 e2e 生成（名字含随机 run id），属一次性用途。
 */
const ALLOWED_PREFIX = "memory-tdai-test-";

/** 二次否决名单：命中也不删。 */
const PROTECTED: Array<(db: string) => boolean> = [
  (d) => d.startsWith("memory-tencentdb-testing"),
  (d) => d.startsWith("memory_dev_"),
  // 当前 .env.devcloud 正在使用的库，绝不能删
  (d) => d === (process.env.VDB_DATABASE ?? ""),
];

const CONFIRMED = process.argv.includes("--confirm");
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function isDeletable(db: string): boolean {
  if (!db.startsWith(ALLOWED_PREFIX)) return false;
  return !PROTECTED.some((p) => p(db));
}

async function main() {
  const client = new TcvdbClient({
    url: VDB_URL!,
    username: process.env.VDB_USERNAME ?? "root",
    apiKey: VDB_API_KEY!,
    database: process.env.VDB_DATABASE ?? "default",
    timeout: 30_000,
    logger: silent,
  });

  const dbResp = await client.request<{ databases?: string[] }>("/database/list", {});
  const dbs = dbResp.databases ?? [];
  const targets = dbs.filter(isDeletable);

  console.log(`Total databases: ${dbs.length}`);
  console.log(`Matching "${ALLOWED_PREFIX}*" and not protected: ${targets.length} items`);

  if (targets.length === 0) {
    console.log("No databases to clean up. Exiting.");
    return;
  }

  if (!CONFIRMED) {
    console.log("\n[DRY-RUN] The following databases would be deleted (add --confirm to execute):");
    for (const db of targets.slice(0, 20)) console.log(`  ${db}`);
    if (targets.length > 20) console.log(`  ... and another ${targets.length - 20} items`);
    console.log(`\nTotal ${targets.length} databases. No deletions performed.`);
    return;
  }

  console.log(`\nDeleting ${targets.length} databases...`);
  let ok = 0;
  const failed: Array<{ db: string; err: string }> = [];

  for (const [i, db] of targets.entries()) {
    // 删除前再校验一次，防止列表被意外污染
    if (!isDeletable(db)) {
      failed.push({ db, err: "failed safety re-check, skipped" });
      continue;
    }
    try {
      await client.dropDatabase(db);
      ok++;
      if ((i + 1) % 50 === 0) console.log(`  Progress ${i + 1}/${targets.length}`);
    } catch (err) {
      failed.push({ db, err: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log(`\nComplete: Success ${ok}, failed ${failed.length}`);
  if (failed.length) {
    console.log("Failure details (first 10):");
    for (const f of failed.slice(0, 10)) console.log(`  ${f.db}: ${f.err}`);
  }
}

main().catch((err) => {
  console.error("cleanup failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
