/**
 * TCVDB **真机** 验证：clearMemoryContent / deleteL0BySession 的删除语义与护栏。
 *
 * 与 mock 单测的区别：这里连真实 VDB，验证的是 VDB 自己的行为，而不是我们
 * 对它的假设。重点确认此前只靠推断的几件事：
 *   1. filter 非空时 delete 只删命中的文档，不会波及其他 team/agent
 *   2. 空值/空 session 护栏在真机链路上确实生效，且不发出删除请求
 *   3. 清空后可继续写入，重复清空幂等
 *
 * 安全约定：
 *   - 在**独立临时库**里操作（名字带时间戳 + PID），不碰任何现有库
 *   - finally 里 drop 整个临时库，失败也不残留
 *   - 凭据只从环境变量读，不落盘、不打印
 *
 * 前置条件：VDB 实例集合数上限 1500，每个 memory 库占 8 个集合。
 * 若余量不足，createCollection 会以 code=15129 失败、store 进 degraded 模式，
 * 导致后续写入静默失败。可先用 scripts/probe-vdb-capacity.ts 查余量。
 *
 * 运行（需先 source .env.devcloud 提供 VDB_URL / VDB_API_KEY）：
 *   node --import tsx scripts/verify-tcvdb-clear.ts
 */
import { TcvdbMemoryStore } from "../src/core/store/tcvdb/memory-store.js";
import { TcvdbClient } from "../src/core/store/tcvdb/client.js";

const VDB_URL = process.env.VDB_URL;
const VDB_API_KEY = process.env.VDB_API_KEY;
const VDB_USERNAME = process.env.VDB_USERNAME ?? "root";

if (!VDB_URL || !VDB_API_KEY) {
  console.error("VDB_URL / VDB_API_KEY environment variables are required (do not put them in code or command history)");
  process.exit(2);
}

/** 独立临时库：带时间戳 + PID，避免与任何现有库或并发实例冲突。 */
const TMP_DB = `clearverify-${Date.now().toString(36)}-${process.pid}`;

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {},
  error: (m: string) => console.error(`  [store-error] ${m}`),
};

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
}

interface Scope { teamId: string; agentId: string; userId: string; sessionId: string }

/** 两个互相独立的作用域，用于验证「清 A 不波及 B」。 */
const A: Scope = { teamId: "vt-a", agentId: "agt-a", userId: "vu-a", sessionId: "vs-a" };
const B: Scope = { teamId: "vt-b", agentId: "agt-b", userId: "vu-b", sessionId: "vs-b" };
/** 与 A 同 team 但不同 agent —— 验证 agent 粒度隔离。 */
const A2: Scope = { teamId: "vt-a", agentId: "agt-a2", userId: "vu-a", sessionId: "vs-a2" };

function l0(scope: Scope, id: string, text: string) {
  return {
    id,
    sessionKey: scope.sessionId,
    sessionId: scope.sessionId,
    teamId: scope.teamId,
    taskId: "",
    userId: scope.userId,
    agentId: scope.agentId,
    role: "user",
    messageText: text,
    recordedAt: new Date().toISOString(),
    timestamp: Date.now(),
  };
}

/** 造一条 L1 记录（结构对齐 MemoryRecord）。 */
function l1(scope: Scope, id: string, content: string) {
  const now = new Date().toISOString();
  return {
    id,
    content,
    type: "episodic" as const,
    priority: 50,
    scene_name: "verify",
    source_message_ids: [],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 1,
    sessionKey: scope.sessionId,
    sessionId: scope.sessionId,
    teamId: scope.teamId,
    userId: scope.userId,
    agentId: scope.agentId,
    taskId: "",
  };
}

/** L1 计数：按 (team, agent, user) 统计，与 clearMemoryContent 的作用域一致。 */
async function countL1(store: TcvdbMemoryStore, scope: Scope): Promise<number> {
  return store.countL1({
    teamId: scope.teamId, agentId: scope.agentId, userId: scope.userId,
  });
}

/** 轮询等L1 到期望条数。 */
async function waitCountL1(
  store: TcvdbMemoryStore, scope: Scope, want: number, timeoutMs = 25_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = await countL1(store, scope);
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

/** VDB 写入到可查询有秒级延迟，轮询等到期望条数（或超时后返回实际值）。 */
async function waitCount(
  store: TcvdbMemoryStore, scope: Scope, want: number, timeoutMs = 25_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = await store.countL0({
      teamId: scope.teamId, agentId: scope.agentId,
      userId: scope.userId, sessionId: scope.sessionId,
    });
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

/** 护栏类断言：不依赖库里有数据，任何 schema 都应成立。 */
async function runGuardChecks(store: TcvdbMemoryStore): Promise<void> {
  console.log("\n4. Empty-value guard (must reject before sending a delete request)");
  for (const bad of [
    { teamId: "", agentId: "agt-x" },
    { teamId: "vt-x", agentId: "" },
    { teamId: "  ", agentId: "  " },
  ]) {
    let threw = false;
    try { await store.clearMemoryContent(bad); } catch { threw = true; }
    check(`clearMemoryContent rejects teamId="${bad.teamId}" agentId="${bad.agentId}"`, threw);
  }
  for (const badSid of ["", "   "]) {
    let threw = false;
    try { await store.deleteL0BySession(badSid, { teamId: "vt-x", agentId: "agt-x" }); }
    catch { threw = true; }
    check(`deleteL0BySession rejects empty sessionId ("${badSid}")`, threw);
  }
}

async function main() {
  const store = new TcvdbMemoryStore({
    url: VDB_URL!,
    username: VDB_USERNAME,
    apiKey: VDB_API_KEY!,
    database: TMP_DB,
    embeddingModel: "bge-base-zh",
    timeout: 30_000,
    logger: silentLogger,
  });

  console.log(`\nTemporary database: ${TMP_DB}(automatically deleted when finished)`);
  await store.init();

  if ((store as unknown as { degraded: boolean }).degraded) {
    console.error(
      "\n✗ Store is degraded; collection creation failed.\n" +
      "  Common cause: The VDB instance reached its 1500-collection limit.\n" +
      "  Run scripts/probe-vdb-capacity.ts to check remaining capacity.\n",
    );
    process.exit(1);
  }

  try {
    console.log("\nPreparing data (L0 + L1)");
    for (let i = 0; i < 3; i++) await store.upsertL0(l0(A, `rec-a-${i}`, `A msg ${i}`), undefined);
    for (let i = 0; i < 2; i++) await store.upsertL0(l0(B, `rec-b-${i}`, `B msg ${i}`), undefined);
    await store.upsertL0(l0(A2, "rec-a2-0", "A2 msg"), undefined);

    // L1：这是本轮重点 —— 之前只写了 L0，L1 删除路径从未被真正验证过
    let l1WriteOk = true;
    for (let i = 0; i < 2; i++) {
      l1WriteOk = (await store.upsertL1(l1(A, `mem-a-${i}`, `A memory ${i}`))) && l1WriteOk;
    }
    l1WriteOk = (await store.upsertL1(l1(B, "mem-b-0", "B memory"))) && l1WriteOk;
    l1WriteOk = (await store.upsertL1(l1(A2, "mem-a2-0", "A2 memory"))) && l1WriteOk;
    check("All L1 writes returned success", l1WriteOk);

    const aN = await waitCount(store, A, 3);
    const bN = await waitCount(store, B, 2);
    const a2N = await waitCount(store, A2, 1);
    check("A L0 wrote 3 records", aN === 3, `Actual ${aN}`);
    check("B L0 wrote 2 records", bN === 2, `Actual ${bN}`);
    check("A2 L0 wrote 1 record(same team, different agent)", a2N === 1, `Actual ${a2N}`);

    const aL1 = await waitCountL1(store, A, 2);
    const bL1 = await waitCountL1(store, B, 1);
    const a2L1 = await waitCountL1(store, A2, 1);
    check("A L1 wrote 2 records", aL1 === 2, `Actual ${aL1}`);
    check("B L1 wrote 1 record", bL1 === 1, `Actual ${bL1}`);
    check("A2 L1 wrote 1 record", a2L1 === 1, `Actual ${a2L1}`);

    if (aN !== 3 || bN !== 2 || a2N !== 1 || aL1 !== 2 || bL1 !== 1) {
      console.error("\nData is not ready; remaining assertions are not meaningful. Exiting early");
      return;
    }

    // ── 1. 作用域正确性：真机上最关键的一条──
    console.log("\n1. clearMemoryContent scope (verify L0 + L1 together)");
    const r = await store.clearMemoryContent({ teamId: A.teamId, agentId: A.agentId });
    check("Returns l0Deleted=3", r.l0Deleted === 3, `Actual ${r.l0Deleted}`);
    check("Returns l1Deleted=2", r.l1Deleted === 2, `Actual ${r.l1Deleted}`);

    check("A L0 cleared", (await waitCount(store, A, 0)) === 0);
    check("A L1 cleared", (await waitCountL1(store, A, 0)) === 0);
    check("B L0 unaffected (no accidental cross-team deletion)", (await waitCount(store, B, 2)) === 2);
    check("B L1 unaffected", (await waitCountL1(store, B, 1)) === 1);
    check("A2 L0 unaffected (no accidental cross-agent deletion)", (await waitCount(store, A2, 1)) === 1);
    check("A2 L1 unaffected (no accidental cross-agent deletion)", (await waitCountL1(store, A2, 1)) === 1);

    // ── 2. 幂等 ──
    console.log("\n2. Idempotency");
    const again = await store.clearMemoryContent({ teamId: A.teamId, agentId: A.agentId });
    check("Repeated L0 clearing returns 0", again.l0Deleted === 0, `Actual ${again.l0Deleted}`);
    check("Repeated L1 clearing returns 0", again.l1Deleted === 0, `Actual ${again.l1Deleted}`);

    // ── 3. 清空后可继续写入（需求验收标准） ──
    console.log("\n3. Writes can continue after clearing");
    await store.upsertL0(l0(A, "rec-a-new", "A msg after clear"), undefined);
    await store.upsertL1(l1(A, "mem-a-new", "A memory after clear"));
    check("New L0 writes visible after clearing", (await waitCount(store, A, 1)) === 1);
    check("New L1 writes visible after clearing", (await waitCountL1(store, A, 1)) === 1);

    // ── 4. 护栏 ──
    await runGuardChecks(store);
    check("B data intact after guard triggers", (await waitCount(store, B, 2)) === 2);

    // ── 5. deleteL0BySession 正常路径 ──
    console.log("\n5. deleteL0BySession normal path");
    const n = await store.deleteL0BySession(B.sessionId, {
      teamId: B.teamId, agentId: B.agentId, userId: B.userId,
    });
    check("Deletion by session returns 2", n === 2, `Actual ${n}`);
    check("B cleared", (await waitCount(store, B, 0)) === 0);
    check("A2 still unaffected", (await waitCount(store, A2, 1)) === 1);

    console.log(`\nResults:${pass} passed, ${fail} failed\n`);
  } finally {
    // 无论成败都清掉临时库
    try {
      const admin = new TcvdbClient({
        url: VDB_URL!, username: VDB_USERNAME, apiKey: VDB_API_KEY!,
        database: TMP_DB, timeout: 30_000, logger: silentLogger,
      });
      await admin.dropDatabase(TMP_DB);
      console.log(`Deleted temporary database ${TMP_DB}`);
    } catch (err) {
      console.error(
        `⚠️ Temporary database ${TMP_DB} Deletion failed; clean up manually:` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await store.close?.();
  }

  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("verify crashed:", err);
  process.exitCode = 1;
});
