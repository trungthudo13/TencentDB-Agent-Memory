#!/usr/bin/env node
/**
 * 腾讯云 VDB (Tencent VectorDB) 数据导出脚本
 *
 * 连接腾讯云向量数据库实例，查询指定数据库下 collection 的文档，导出为 .jsonl 文件。
 * 仅支持腾讯云向量数据库（Tencent VectorDB），不支持其他厂商的向量数据库。
 *
 * 所有连接参数通过 CLI 传入，无需 .env 文件。
 *
 * 用法：
 *   node ./bin/export-tencent-vdb.mjs --url <地址> --username <用户名> --api-key <密钥> --database <库名>
 *   node ./bin/export-tencent-vdb.mjs --url <地址> --username <用户名> --api-key <密钥> --database <库名> --probe
 *   node ./bin/export-tencent-vdb.mjs --url <地址> --username <用户名> --api-key <密钥> --database <库名> -c <collection> -o /tmp/backup
 *
 * 输出：
 *   默认输出到当前工作目录下的 ./vdb-export-YYYY-MM-DD/，可通过 -o 指定。
 *   <outputDir>/
 *   ├── <collection>.jsonl    — 每行一个 JSON 文档
 *   ├── schemas.json          — 导出的 collection 表结构（索引、embedding 配置等）
 *   └── export-meta.json      — 导出元信息
 *
 * 导出字段说明：
 *   默认行为：导出所有字段，但跳过 vector（稠密向量，1024维浮点数组，体积大）。
 *   加 --include-vectors：导出全部字段，包括 vector，不跳过任何内容。
 *   注：sparse_vector（BM25 稀疏向量）始终导出，不受此开关影响。
 *
 * 依赖：Node.js >= 18（内置 fetch）
 */

import fs from "node:fs";
import path from "node:path";

// ============================================================
// CLI 参数解析（含 VDB 连接信息）
// ============================================================

interface VDBConfig {
  url: string;
  username: string;
  apiKey: string;
  database: string;
  timeout: number;
}

interface CliArgs {
  // 连接参数
  url?: string;
  username?: string;
  apiKey?: string;
  database?: string;
  timeout: number;
  // 导出参数
  output: string;
  collection?: string;
  filter?: string;
  limit?: number;
  offset: number;
  includeVectors: boolean;
  probe: boolean;
  help: boolean;
}

const PAGE_SIZE = 100;

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    timeout: 30000,
    output: `./vdb-export-${new Date().toISOString().slice(0, 10)}`,
    offset: 0,
    includeVectors: false,
    probe: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--url":
        result.url = args[++i];
        break;
      case "--username":
        result.username = args[++i];
        break;
      case "--api-key":
        result.apiKey = args[++i];
        break;
      case "--database":
        result.database = args[++i];
        break;
      case "--timeout":
        result.timeout = parseInt(args[++i], 10) || 30000;
        break;
      case "--output":
      case "-o":
        result.output = args[++i];
        break;
      case "--collection":
      case "-c":
        result.collection = args[++i];
        break;
      case "--filter":
      case "-f":
        result.filter = args[++i];
        break;
      case "--limit":
      case "-l": {
        const v = parseInt(args[++i], 10);
        if (isNaN(v) || v < 1) {
          console.error(`❌ --limit must be >= 1; received: ${args[i]}`);
          process.exit(1);
        }
        result.limit = v;
        break;
      }
      case "--offset": {
        const v = parseInt(args[++i], 10);
        if (isNaN(v) || v < 0) {
          console.error(`❌ --offset must be >= 0; received: ${args[i]}`);
          process.exit(1);
        }
        result.offset = v;
        break;
      }
      case "--include-vectors":
        result.includeVectors = true;
        break;
      case "--probe":
        result.probe = true;
        break;
      case "--help":
      case "-h":
        result.help = true;
        break;
    }
  }

  return result;
}

function validateConfig(args: CliArgs): VDBConfig {
  const missing: string[] = [];
  if (!args.url) missing.push("--url");
  if (!args.username) missing.push("--username");
  if (!args.apiKey) missing.push("--api-key");
  if (!args.database) missing.push("--database");

  if (missing.length > 0) {
    console.error("❌ Missing required arguments:");
    for (const k of missing) {
      console.error(`   - ${k}`);
    }
    console.error();
    console.error("Example:");
    console.error();
    console.error('  node ./bin/export-tencent-vdb.mjs \\');
    console.error('    --url "http://your-vdb-host:8100" \\');
    console.error('    --username "root" \\');
    console.error('    --api-key "your-api-key" \\');
    console.error('    --database "your-database"');
    console.error();
    console.error("Use --help for full argument details.");
    process.exit(1);
  }

  return {
    url: args.url!,
    username: args.username!,
    apiKey: args.apiKey!,
    database: args.database!,
    timeout: args.timeout,
  };
}

function printHelp(): void {
  console.log(`
Tencent VectorDB data export script

Usage:
  node ./bin/export-tencent-vdb.mjs [connection options] [options]

Connection options (required):
      --url <url>               VDB instance HTTP URL (e.g. http://your-vdb-host:8100)
      --username <username>        Authentication username (e.g. root)
      --api-key <key>           Authentication key
      --database <database>          Database name

Options:
      --timeout <ms>           Request timeout (default: 30000)
  -o, --output <directory>            Output directory(default: ./vdb-export-YYYY-MM-DD)
  -c, --collection <full name>        Export only the named collection (exact match; export all if omitted)
  -f, --filter <expression>          VDB filter expression (e.g. 'agent_id = "xxx"')
  -l, --limit <count>             Maximum records to export (all if omitted)
      --offset <offset>            Starting record (default: 0); must be a multiple of the page size
      --include-vectors          Keep the dense vector field (skipped by default)
      --probe                    Test connectivity, list collections, and exit
  -h, --help                     Show help

Output:
  <outputDir>/
  ├── <collection-full-name>.jsonl     One JSON document per line
  ├── schemas.json               Schema
  └── export-meta.json           Export metadata

Exported fields:
  Skip vector (dense vectors) by default; keep sparse_vector (BM25).
  Add --include-vectors to export all fields.

Example:
  # Test connectivity
  node ./bin/export-tencent-vdb.mjs \\
    --url "http://gz-vdb-xxx:8100" --username root --api-key "xxx" --database mydb \\
    --probe

  # Full export
  node ./bin/export-tencent-vdb.mjs \\
    --url "http://gz-vdb-xxx:8100" --username root --api-key "xxx" --database mydb

  # Export a specific collection to a directory
  node ./bin/export-tencent-vdb.mjs \\
    --url "http://gz-vdb-xxx:8100" --username root --api-key "xxx" --database mydb \\
    -c mydb_l0_conversations -o /tmp/backup

  # With a filter
  node ./bin/export-tencent-vdb.mjs \\
    --url "http://gz-vdb-xxx:8100" --username root --api-key "xxx" --database mydb \\
    -f 'role = "user"'
`);
}

// ============================================================
// VDB HTTP Client
// ============================================================

class VDBClient {
  private baseUrl: string;
  private authHeader: string;
  private database: string;
  private timeout: number;

  constructor(cfg: VDBConfig) {
    this.baseUrl = cfg.url.replace(/\/$/, "");
    this.authHeader = `Bearer account=${cfg.username}&api_key=${cfg.apiKey}`;
    this.database = cfg.database;
    this.timeout = cfg.timeout;
  }

  async request<T>(apiPath: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${apiPath}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.authHeader,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "(unable to read body)");
      throw new Error(`VDB API error: HTTP ${resp.status} — ${text.slice(0, 500)}`);
    }

    const json = (await resp.json()) as { code: number; msg: string } & T;
    if (json.code !== 0) {
      throw new Error(`VDB API error [${apiPath}]: code=${json.code}, msg=${json.msg}`);
    }
    return json;
  }

  async listCollections(): Promise<
    Array<{ collection: string; documentCount: number }>
  > {
    const result = await this.request<{
      collections: Array<{
        collection: string;
        documentCount: number;
        [key: string]: unknown;
      }>;
    }>("/collection/list", {
      database: this.database,
    });
    return (result.collections || []).map((c) => ({
      collection: c.collection,
      documentCount: c.documentCount ?? 0,
    }));
  }

  async queryDocuments(
    collection: string,
    options: {
      limit: number;
      offset: number;
      filter?: string;
      retrieveVector?: boolean;
    },
  ): Promise<{
    documents: Array<Record<string, unknown>>;
    count: number;
  }> {
    const query: Record<string, unknown> = {
      limit: options.limit,
      offset: options.offset,
    };
    if (options.filter) {
      query.filter = options.filter;
    }
    if (options.retrieveVector) {
      query.retrieveVector = true;
    }

    const result = await this.request<{
      documents: Array<Record<string, unknown>>;
      count: number;
    }>("/document/query", {
      database: this.database,
      collection,
      readConsistency: "strongConsistency",
      query,
    });

    return {
      documents: result.documents || [],
      count: result.count ?? 0,
    };
  }

  async describeCollection(collection: string): Promise<Record<string, unknown>> {
    const result = await this.request<{
      collection: Record<string, unknown>;
    }>("/collection/describe", {
      database: this.database,
      collection,
    });
    return result.collection || {};
  }
}

// ============================================================
// 导出逻辑
// ============================================================

interface ExportOptions {
  filter?: string;
  limit?: number;
  offset: number;
  includeVectors: boolean;
  expectedTotal?: number;
}

async function exportCollection(
  client: VDBClient,
  collection: string,
  outputDir: string,
  options: ExportOptions,
): Promise<{ docCount: number; filePath: string }> {
  const filePath = path.join(outputDir, `${collection}.jsonl`);
  const writeStream = fs.createWriteStream(filePath, { encoding: "utf-8" });

  const isRangeMode = options.limit !== undefined;
  const maxDocs = options.limit ?? Infinity;
  const pageSize = isRangeMode ? Math.min(options.limit!, PAGE_SIZE) : PAGE_SIZE;

  let currentOffset = options.offset;
  let totalExported = 0;
  let hasMore = true;

  console.log(`  📦 ${collection}`);
  if (options.expectedTotal !== undefined) {
    console.log(`     Total documents: ${options.expectedTotal}`);
  }
  if (options.filter) {
    console.log(`     Filter: ${options.filter}`);
  }
  if (isRangeMode) {
    console.log(`     Export range: offset=${options.offset}, limit=${options.limit}`);
  }

  while (hasMore && totalExported < maxDocs) {
    const remaining = maxDocs - totalExported;
    const thisPageSize = Math.min(pageSize, remaining);

    try {
      const result = await client.queryDocuments(collection, {
        limit: thisPageSize,
        offset: currentOffset,
        filter: options.filter,
        retrieveVector: options.includeVectors,
      });

      const docs = result.documents;
      if (!docs || docs.length === 0) {
        hasMore = false;
        break;
      }

      for (const doc of docs) {
        const exportDoc = { ...doc };
        if (!options.includeVectors) {
          delete exportDoc.vector;
        }
        writeStream.write(JSON.stringify(exportDoc) + "\n");
      }

      totalExported += docs.length;
      currentOffset += docs.length;

      if (options.expectedTotal !== undefined && !isRangeMode) {
        const pct = Math.min(
          100,
          Math.round((totalExported / options.expectedTotal) * 100),
        );
        process.stdout.write(
          `\r     Progress: ${totalExported}/${options.expectedTotal} (${pct}%)`,
        );
      } else {
        process.stdout.write(`\r     Exported: ${totalExported} records`);
      }

      if (docs.length < thisPageSize) {
        hasMore = false;
      }
    } catch (err) {
      console.error(
        `\n     ❌ Query failed (offset=${currentOffset}): ${err instanceof Error ? err.message : String(err)}`,
      );
      hasMore = false;
    }
  }

  writeStream.end();
  await new Promise<void>((resolve) => writeStream.on("finish", resolve));

  console.log(
    `\n     ✅ Complete: ${totalExported} records → ${path.basename(filePath)}`,
  );

  return { docCount: totalExported, filePath };
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const config = validateConfig(args);

  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║   Tencent VectorDB data export tool        ║");
  console.log("╚═══════════════════════════════════════════════════╝");
  console.log();
  console.log(`📌 VDB URL:     ${config.url}`);
  console.log(`📌 Database:       ${config.database}`);
  console.log(`📌 Output directory:     ${args.output}`);
  if (args.collection) {
    console.log(`📌 Selected export:     ${args.collection}`);
  }
  if (args.filter) {
    console.log(`📌 Filter:     ${args.filter}`);
  }
  if (args.limit !== undefined) {
    console.log(`📌 Export limit:     ${args.limit} records`);
  }
  if (args.offset > 0) {
    console.log(`📌 Starting offset:     ${args.offset}`);
  }
  if (args.includeVectors) {
    console.log(`📌 Include vectors: yes`);
  }
  console.log();

  fs.mkdirSync(args.output, { recursive: true });

  const client = new VDBClient(config);

  let allCollections: Array<{ collection: string; documentCount: number }>;
  try {
    allCollections = await client.listCollections();
  } catch (err) {
    console.error(
      `❌ Failed to list collections: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  let targetCollections: Array<{ collection: string; documentCount: number }>;
  if (args.collection) {
    const found = allCollections.find((c) => c.collection === args.collection);
    if (!found) {
      console.error(
        `❌ Collection "${args.collection}" does not exist. Available collections:`,
      );
      for (const c of allCollections) {
        console.error(`   - ${c.collection} (${c.documentCount} records)`);
      }
      process.exit(1);
    }
    targetCollections = [found];
  } else {
    targetCollections = allCollections;
    console.log(
      `🔍 Found ${targetCollections.length} collections:`,
    );
    for (const c of targetCollections) {
      console.log(`   - ${c.collection} (${c.documentCount} records)`);
    }
  }

  if (targetCollections.length === 0) {
    console.log("⚠️  Databasehas no collections; no data to export");
    process.exit(0);
  }

  // --probe 模式：只测试连通性，列出信息后退出
  if (args.probe) {
    console.log();
    console.log("✅ Connectivity test passed");
    console.log();
    console.log(`  VDB URL:   ${config.url}`);
    console.log(`  Database:     ${config.database}`);
    console.log(`  Collection: ${targetCollections.length} items`);
    const totalDocs = targetCollections.reduce((s, c) => s + c.documentCount, 0);
    console.log(`  Total documents:   ${totalDocs}`);
    console.log();
    for (const c of targetCollections) {
      console.log(`    - ${c.collection} (${c.documentCount} records)`);
    }
    console.log();
    process.exit(0);
  }

  console.log();

  // 获取并保存表结构
  const schemas: Record<string, Record<string, unknown>> = {};
  console.log("📐 Fetching schemas...");
  for (const col of targetCollections) {
    try {
      const schema = await client.describeCollection(col.collection);
      schemas[col.collection] = schema;
      const indexCount = Array.isArray(schema.indexes) ? schema.indexes.length : 0;
      const emb = schema.embedding as Record<string, unknown> | undefined;
      const embInfo = emb ? `embedding=${emb.field}→${emb.model}` : "No embedding";
      console.log(`   ✅ ${col.collection} (${indexCount} indexes, ${embInfo})`);
    } catch (err) {
      console.error(
        `   ⚠️ ${col.collection} Failed to fetch schema: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log();

  const schemaPath = path.join(args.output, "schemas.json");
  fs.writeFileSync(schemaPath, JSON.stringify(schemas, null, 2) + "\n");

  const exportResults: Array<{
    collection: string;
    docCount: number;
    filePath: string;
  }> = [];

  for (const col of targetCollections) {
    try {
      const result = await exportCollection(client, col.collection, args.output, {
        filter: args.filter,
        limit: args.limit,
        offset: args.offset,
        includeVectors: args.includeVectors,
        expectedTotal: col.documentCount,
      });
      exportResults.push({ collection: col.collection, ...result });
    } catch (err) {
      console.error(
        `❌ Export ${col.collection} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      exportResults.push({
        collection: col.collection,
        docCount: 0,
        filePath: "",
      });
    }
    console.log();
  }

  const meta = {
    exportedAt: new Date().toISOString(),
    vdbUrl: config.url,
    database: config.database,
    filter: args.filter ?? null,
    offset: args.offset,
    limit: args.limit ?? null,
    includeVectors: args.includeVectors,
    collections: exportResults.map((r) => ({
      collection: r.collection,
      documentCount: r.docCount,
      file: r.filePath ? path.basename(r.filePath) : null,
    })),
    totalDocuments: exportResults.reduce((sum, r) => sum + r.docCount, 0),
  };

  const metaPath = path.join(args.output, "export-meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");

  console.log("═══════════════════════════════════════════════════");
  console.log("  ✅ Export complete");
  console.log("═══════════════════════════════════════════════════");
  console.log();
  console.log(`  📁 Output directory: ${args.output}`);
  console.log(`  📊 Total documents: ${meta.totalDocuments}`);
  for (const r of exportResults) {
    const status = r.docCount > 0 ? "✅" : "⚠️";
    console.log(
      `     ${status} ${r.collection}: ${r.docCount} records`,
    );
  }
  console.log(`  📋 Metadata:   ${path.basename(metaPath)}`);
  console.log(`  📐 Schema:   ${path.basename(schemaPath)}`);
  console.log();
}

main().catch((err) => {
  console.error(
    `\n❌ Export failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
