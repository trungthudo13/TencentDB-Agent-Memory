#!/usr/bin/env python3
"""
v2 → v3 数据迁移脚本

1. 对 vectors.db 做表结构升级 + 存量数据字段补齐：
   - l1_records: 新增 team_id, task_id, user_id, agent_id, version
   - l0_conversations: 新增 team_id, task_id, user_id, agent_id
   - l1_fts / l0_fts: FTS5 不支持 ALTER，需 DROP + 重建
   - 新增空表: memory_audit, skills, skill_fts

2. L2/L3 文件迁移（复制到 v3 profiles 目录）：
   - 将 scene_blocks/、persona.md、.metadata/ 复制到
     profiles/team%3Adefault%7Cagent%3Adefault/ 下

不处理：
  - skill_vec: vec0 虚拟表，依赖运行时 embedding dimensions 参数，
    由 v3 服务启动时自动创建（仅在 dimensions > 0 时创建）
  - metadata.db: 独立数据库，由管控面创建和维护
  - l1_vec / l0_vec / embedding_meta: 表结构无变更

用法:
    python v2-to-v3-migrate.py /path/to/memory-tdai
    python v2-to-v3-migrate.py /path/to/memory-tdai --dry-run
    python v2-to-v3-migrate.py /path/to/memory-tdai --db-only     (仅迁移数据库，跳过 L2/L3 文件)
"""

import argparse
import os
import shutil
import sqlite3
import sys
import time
from datetime import datetime, timezone


# ============================================================
# 默认值
# ============================================================
DEFAULT_TEAM_ID = "default"
DEFAULT_USER_ID = "default"
DEFAULT_AGENT_ID = "default"
DEFAULT_TASK_ID = ""
DEFAULT_VERSION = 0


# ============================================================
# 新增表 DDL（空表）
# ============================================================
MEMORY_AUDIT_DDL = """
CREATE TABLE IF NOT EXISTS memory_audit (
    audit_id      TEXT PRIMARY KEY,
    record_id     TEXT NOT NULL,
    layer         TEXT NOT NULL CHECK (layer IN ('L1','L2','L3')),
    action        TEXT NOT NULL CHECK (action IN ('update','delete')),
    team_id       TEXT,
    agent_id      TEXT,
    user_id       TEXT,
    task_id       TEXT,
    version       INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    request_id    TEXT
);
"""

MEMORY_AUDIT_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_memory_audit_record    ON memory_audit(record_id, updated_at_ms);",
    "CREATE INDEX IF NOT EXISTS idx_memory_audit_isolation ON memory_audit(team_id, agent_id, user_id, task_id);",
    "CREATE INDEX IF NOT EXISTS idx_memory_audit_time      ON memory_audit(updated_at_ms);",
]

SKILLS_DDL = """
CREATE TABLE IF NOT EXISTS skills (
    row_id          TEXT PRIMARY KEY,
    skill_id        TEXT NOT NULL,
    version         INTEGER NOT NULL,
    is_head         INTEGER NOT NULL DEFAULT 1,
    user_id         TEXT NOT NULL,
    owner_agent_id  TEXT NOT NULL,
    team_id         TEXT NOT NULL,
    task_id         TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    manifest_json   TEXT NOT NULL DEFAULT '[]',
    storage_dir     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at_ms   INTEGER NOT NULL,
    updated_at_ms   INTEGER NOT NULL,
    UNIQUE(skill_id, version)
);
"""

SKILLS_INDEXES = [
    "CREATE UNIQUE INDEX IF NOT EXISTS uniq_skills_team_agent_name_head ON skills(team_id, owner_agent_id, name) WHERE is_head=1 AND status='active';",
    "CREATE INDEX IF NOT EXISTS idx_skills_team_head     ON skills(team_id, is_head, status);",
    "CREATE INDEX IF NOT EXISTS idx_skills_owner_head    ON skills(owner_agent_id, is_head, status);",
    "CREATE INDEX IF NOT EXISTS idx_skills_user          ON skills(user_id, is_head);",
    "CREATE INDEX IF NOT EXISTS idx_skills_skill_version ON skills(skill_id, version DESC);",
    "CREATE INDEX IF NOT EXISTS idx_skills_task_audit    ON skills(task_id, created_at_ms DESC);",
]

SKILL_FTS_DDL = """
CREATE VIRTUAL TABLE IF NOT EXISTS skill_fts USING fts5(
    name,
    description,
    content,
    skill_id        UNINDEXED,
    team_id         UNINDEXED,
    owner_agent_id  UNINDEXED,
    task_id         UNINDEXED,
    user_id         UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 1'
);
"""

# ============================================================
# 新版 L1 FTS DDL（含租户隔离列）
# ============================================================
L1_FTS_DDL = """
CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(
    content,
    content_original        UNINDEXED,
    record_id               UNINDEXED,
    type                    UNINDEXED,
    priority                UNINDEXED,
    scene_name              UNINDEXED,
    session_key             UNINDEXED,
    session_id              UNINDEXED,
    team_id                 UNINDEXED,
    task_id                 UNINDEXED,
    user_id                 UNINDEXED,
    agent_id                UNINDEXED,
    version                 UNINDEXED,
    timestamp_str           UNINDEXED,
    timestamp_start         UNINDEXED,
    timestamp_end           UNINDEXED,
    metadata_json           UNINDEXED
);
"""

# ============================================================
# 新版 L0 FTS DDL（含租户隔离列）
# ============================================================
L0_FTS_DDL = """
CREATE VIRTUAL TABLE IF NOT EXISTS l0_fts USING fts5(
    message_text,
    message_text_original   UNINDEXED,
    record_id               UNINDEXED,
    session_key             UNINDEXED,
    session_id              UNINDEXED,
    team_id                 UNINDEXED,
    task_id                 UNINDEXED,
    user_id                 UNINDEXED,
    agent_id                UNINDEXED,
    role                    UNINDEXED,
    recorded_at             UNINDEXED,
    timestamp               UNINDEXED
);
"""


def log(msg: str):
    print(f"[migrate] {msg}")


def safe_alter(db: sqlite3.Connection, table: str, col: str, col_def: str):
    """幂等的 ALTER TABLE ADD COLUMN（忽略重复列错误）。"""
    try:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {col} {col_def};")
        log(f"  + Add column {table}.{col}")
    except sqlite3.OperationalError as e:
        if "duplicate column name" in str(e).lower():
            log(f"  ~ Column already exists {table}.{col}; skipping")
        else:
            raise


def migrate_l1_records(db: sqlite3.Connection):
    """L1 表：新增 team_id, task_id, user_id, agent_id, version。"""
    log("--- L1: l1_records ---")
    before = db.execute("SELECT COUNT(*) FROM l1_records").fetchone()[0]
    log(f"  Record count before migration: {before}")

    safe_alter(db, "l1_records", "team_id", "TEXT DEFAULT ''")
    safe_alter(db, "l1_records", "task_id", "TEXT DEFAULT ''")
    safe_alter(db, "l1_records", "user_id", "TEXT NOT NULL DEFAULT 'default'")
    safe_alter(db, "l1_records", "agent_id", "TEXT NOT NULL DEFAULT 'default'")
    safe_alter(db, "l1_records", "version", "INTEGER NOT NULL DEFAULT 0")

    # 补齐存量数据
    db.execute("UPDATE l1_records SET team_id = ? WHERE team_id = '' OR team_id IS NULL",
               (DEFAULT_TEAM_ID,))
    db.execute("UPDATE l1_records SET user_id = ? WHERE user_id = '' OR user_id IS NULL",
               (DEFAULT_USER_ID,))
    db.execute("UPDATE l1_records SET agent_id = ? WHERE agent_id = '' OR agent_id IS NULL",
               (DEFAULT_AGENT_ID,))
    db.execute("UPDATE l1_records SET task_id = ? WHERE task_id = '' OR task_id IS NULL",
               (DEFAULT_TASK_ID,))
    db.execute("UPDATE l1_records SET version = ? WHERE version IS NULL OR version < 0",
               (DEFAULT_VERSION,))
    db.execute("UPDATE l1_records SET session_id = ? WHERE session_id = '' OR session_id IS NULL",
               ("default",))

    # 新增索引
    indexes = [
        "CREATE INDEX IF NOT EXISTS idx_l1_task_updated       ON l1_records(task_id, updated_time);",
        "CREATE INDEX IF NOT EXISTS idx_l1_team_agent_updated  ON l1_records(team_id, agent_id, updated_time);",
        "CREATE INDEX IF NOT EXISTS idx_l1_user_agent_session  ON l1_records(user_id, agent_id, session_id);",
        "CREATE INDEX IF NOT EXISTS idx_l1_user_updated        ON l1_records(user_id, updated_time);",
        "CREATE INDEX IF NOT EXISTS idx_l1_agent_updated       ON l1_records(agent_id, updated_time);",
    ]
    for idx_sql in indexes:
        db.execute(idx_sql)
        log(f"  + Index: {idx_sql.split(' ON ')[0].split()[-1]}")

    log(f"  L1 Migration complete; record count: {before}")


def migrate_l0_conversations(db: sqlite3.Connection):
    """L0 表：新增 team_id, task_id, user_id, agent_id。"""
    log("--- L0: l0_conversations ---")
    before = db.execute("SELECT COUNT(*) FROM l0_conversations").fetchone()[0]
    log(f"  Record count before migration: {before}")

    safe_alter(db, "l0_conversations", "team_id", "TEXT DEFAULT ''")
    safe_alter(db, "l0_conversations", "task_id", "TEXT DEFAULT ''")
    safe_alter(db, "l0_conversations", "user_id", "TEXT NOT NULL DEFAULT 'default'")
    safe_alter(db, "l0_conversations", "agent_id", "TEXT NOT NULL DEFAULT 'default'")

    # 补齐存量数据
    db.execute("UPDATE l0_conversations SET team_id = ? WHERE team_id = '' OR team_id IS NULL",
               (DEFAULT_TEAM_ID,))
    db.execute("UPDATE l0_conversations SET user_id = ? WHERE user_id = '' OR user_id IS NULL",
               (DEFAULT_USER_ID,))
    db.execute("UPDATE l0_conversations SET agent_id = ? WHERE agent_id = '' OR agent_id IS NULL",
               (DEFAULT_AGENT_ID,))
    db.execute("UPDATE l0_conversations SET task_id = ? WHERE task_id = '' OR task_id IS NULL",
               (DEFAULT_TASK_ID,))
    db.execute("UPDATE l0_conversations SET session_id = ? WHERE session_id = '' OR session_id IS NULL",
               ("default",))

    # 新增索引
    indexes = [
        "CREATE INDEX IF NOT EXISTS idx_l0_task              ON l0_conversations(task_id);",
        "CREATE INDEX IF NOT EXISTS idx_l0_team_agent        ON l0_conversations(team_id, agent_id);",
        "CREATE INDEX IF NOT EXISTS idx_l0_user_agent_session ON l0_conversations(user_id, agent_id, session_id);",
        "CREATE INDEX IF NOT EXISTS idx_l0_user_recorded     ON l0_conversations(user_id, recorded_at);",
        "CREATE INDEX IF NOT EXISTS idx_l0_agent_recorded    ON l0_conversations(agent_id, recorded_at);",
    ]
    for idx_sql in indexes:
        db.execute(idx_sql)
        log(f"  + Index: {idx_sql.split(' ON ')[0].split()[-1]}")

    log(f"  L0 Migration complete; record count: {before}")


def rebuild_fts(db: sqlite3.Connection, fts_table: str, ddl: str,
                data_table: str, columns: list[str], source_exprs: list[str]):
    """
    删除旧 FTS 表，创建新版，从数据表全量重建索引。
    """
    log(f"--- FTS: {fts_table} ---")
    # 检查旧 FTS 表是否存在
    exists = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (fts_table,)
    ).fetchone()

    if exists:
        # 先查旧表列数来判断是否需要重建
        old_cols = db.execute(f"PRAGMA table_info({fts_table})").fetchall()
        new_col_names = [c.split()[0] for c in columns]
        old_col_names = [row[1] for row in old_cols]

        if set(new_col_names).issubset(set(old_col_names)):
            log(f"  {fts_table} already has all new columns; skipping rebuild")
            return

        log(f"  Delete old {fts_table}...")
        db.execute(f"DROP TABLE IF EXISTS {fts_table};")

    log(f"  Create new version of {fts_table}...")
    db.execute(ddl)

    log(f"  Rebuild FTS index from {data_table}...")
    cols_str = ", ".join(columns)
    sources_str = ", ".join(source_exprs)
    insert_sql = f"INSERT INTO {fts_table}({cols_str}) SELECT {sources_str} FROM {data_table};"
    db.execute(insert_sql)
    count = db.execute(f"SELECT COUNT(*) FROM {fts_table}").fetchone()[0]
    log(f"  {fts_table} Rebuild complete; rows: {count}")


def create_new_tables(db: sqlite3.Connection):
    """创建新版新增的空表。"""
    log("--- New tables ---")

    log("  Create memory_audit...")
    db.execute(MEMORY_AUDIT_DDL)
    for idx_sql in MEMORY_AUDIT_INDEXES:
        db.execute(idx_sql)

    log("  Create skills...")
    db.execute(SKILLS_DDL)
    for idx_sql in SKILLS_INDEXES:
        db.execute(idx_sql)

    log("  Create skill_fts...")
    db.execute(SKILL_FTS_DDL)

    log("  New tables created")


def migrate_l2_l3_files(data_dir: str):
    """
    L2/L3 文件迁移：复制到 v3 profiles 目录。

    将 data_dir 下的 scene_blocks/、persona.md、.metadata/ 复制到
    data_dir/profiles/team%3Adefault%7Cagent%3Adefault/ 下。
    如果目标目录已存在对应文件则跳过。
    """
    PROFILE_DIR = "team%3Adefault%7Cagent%3Adefault"
    log("--- L2/L3 file migration ---")

    src_dir = os.path.abspath(data_dir)
    dst_root = os.path.join(src_dir, "profiles", PROFILE_DIR)

    # 需要复制的目录和文件
    to_copy = {
        "scene_blocks": os.path.join(src_dir, "scene_blocks"),
        ".metadata": os.path.join(src_dir, ".metadata"),
        "persona.md": os.path.join(src_dir, "persona.md"),
    }

    for name, src_path in to_copy.items():
        if not os.path.exists(src_path):
            log(f"  ~ {name} does not exist; skipping")
            continue

        dst_path = os.path.join(dst_root, name)

        if os.path.isdir(src_path):
            # 目录：递归复制
            if os.path.exists(dst_path):
                log(f"  ~ {name}/ already exists; skipping directory copy")
                continue
            os.makedirs(dst_root, exist_ok=True)
            shutil.copytree(src_path, dst_path)
            log(f"  + Copy directory: {name}/ -> profiles/{PROFILE_DIR}/{name}/")
        else:
            # 文件
            if os.path.exists(dst_path):
                log(f"  ~ {name} already exists; skipping")
                continue
            os.makedirs(dst_root, exist_ok=True)
            shutil.copy2(src_path, dst_path)
            log(f"  + Copy file: {name} -> profiles/{PROFILE_DIR}/{name}")

    log("  L2/L3 file migration complete")


def main():
    parser = argparse.ArgumentParser(
        description="v2 → v3 migration script (SQLite vectors.db schema upgrade)"
    )
    parser.add_argument(
        "data_dir",
        help="v2 data directory, e.g. /path/to/memory-tdai (must contain vectors.db)"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Check only; do not modify the database"
    )
    parser.add_argument(
        "--no-backup", action="store_true",
        help="Skip backup"
    )
    parser.add_argument(
        "--db-only", action="store_true",
        help="Migrate the database only; skip L2/L3 files"
    )
    args = parser.parse_args()

    data_dir = os.path.abspath(args.data_dir)
    db_path = os.path.join(data_dir, "vectors.db")

    if not os.path.isfile(db_path):
        log(f"Error: vectors.db not found: {db_path}")
        sys.exit(1)

    # ---- 连接数据库 ----
    log(f"Data directory: {data_dir}")
    log(f"Database:   {db_path}")

    if args.dry_run:
        log("[DRY-RUN] Check only; do not modify the database\n")
        # dry-run: 只读连接，打印表信息
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        tables = ["l1_records", "l0_conversations", "l1_fts", "l0_fts", "memory_audit", "skills"]
        for t in tables:
            exists = db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                (t,)
            ).fetchone()
            if exists:
                cols = db.execute(f"PRAGMA table_info({t})").fetchall()
                count = db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                log(f"  [{t}] Column count={len(cols)}, Line count={count}")
                log(f"         Columns: {[c[1] for c in cols]}")
            else:
                log(f"  [{t}] Missing")
        db.close()

        # dry-run: 检查 L2/L3 文件
        if not args.db_only:
            log("--- L2/L3 file check ---")
            profile_dir = "team%3Adefault%7Cagent%3Adefault"
            for name in ["scene_blocks", ".metadata", "persona.md"]:
                src = os.path.join(data_dir, name)
                dst = os.path.join(data_dir, "profiles", profile_dir, name)
                src_status = "Present" if os.path.exists(src) else "Missing"
                dst_status = "Present" if os.path.exists(dst) else "Missing"
                log(f"  {name}: Source={src_status}, Target={dst_status}")

        log("\nDRY-RUN complete; no changes made")
        return

    # ---- 备份 ----
    if not args.no_backup:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        backup_path = f"{db_path}.bak.{timestamp}"
        log(f"Backup: {backup_path}")
        shutil.copy2(db_path, backup_path)

    # ---- WAL checkpoint ----
    log("Run WAL checkpoint...")
    ck_db = sqlite3.connect(db_path)
    ck_db.execute("PRAGMA wal_checkpoint(TRUNCATE);")
    ck_db.close()

    # ---- 迁移 ----
    db = sqlite3.connect(db_path)
    db.execute("PRAGMA journal_mode = WAL;")

    t_start = time.time()

    migrate_l1_records(db)
    migrate_l0_conversations(db)

    # FTS 表重建
    rebuild_fts(
        db, "l1_fts", L1_FTS_DDL, "l1_records",
        columns=[
            "content", "content_original", "record_id", "type", "priority",
            "scene_name", "session_key", "session_id",
            "team_id", "task_id", "user_id", "agent_id", "version",
            "timestamp_str", "timestamp_start", "timestamp_end", "metadata_json",
        ],
        source_exprs=[
            "content", "content", "record_id", "type", "priority",
            "scene_name", "session_key", "session_id",
            "team_id", "task_id", "user_id", "agent_id", "version",
            "timestamp_str", "timestamp_start", "timestamp_end", "metadata_json",
        ],
    )
    rebuild_fts(
        db, "l0_fts", L0_FTS_DDL, "l0_conversations",
        columns=[
            "message_text", "message_text_original", "record_id",
            "session_key", "session_id",
            "team_id", "task_id", "user_id", "agent_id",
            "role", "recorded_at", "timestamp",
        ],
        source_exprs=[
            "message_text", "message_text", "record_id",
            "session_key", "session_id",
            "team_id", "task_id", "user_id", "agent_id",
            "role", "recorded_at", "timestamp",
        ],
    )

    # 新增表
    create_new_tables(db)

    db.commit()
    db.close()

    # L2/L3 文件迁移（除非指定 --db-only）
    if not args.db_only:
        migrate_l2_l3_files(data_dir)

    elapsed = time.time() - t_start
    log(f"\nMigration complete! Duration: {elapsed:.2f}s")


if __name__ == "__main__":
    main()
