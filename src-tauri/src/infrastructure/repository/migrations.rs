use crate::error;
use rusqlite::{params, Connection, Result};

pub fn run_migrations(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    let current_version: i32 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    // Migration 1: Initial Baseline
    if current_version < 1 {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS clipboard_history (
                id INTEGER PRIMARY KEY,
                content_type TEXT NOT NULL,
                content TEXT NOT NULL,
                source_app TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                preview TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        ",
        )?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (1)", [])?;
    }

    // Migration 2: Add core feature columns
    if current_version < 2 {
        let columns = [
            ("is_pinned", "INTEGER NOT NULL DEFAULT 0"),
            ("tags", "TEXT NOT NULL DEFAULT '[]'"),
            ("use_count", "INTEGER NOT NULL DEFAULT 0"),
            ("pinned_order", "INTEGER NOT NULL DEFAULT 0"),
            ("content_hash", "INTEGER NOT NULL DEFAULT 0"),
            ("html_content", "TEXT"),
        ];

        for (name, def) in columns {
            if !has_column(conn, "clipboard_history", name)? {
                conn.execute(
                    &format!("ALTER TABLE clipboard_history ADD COLUMN {} {}", name, def),
                    [],
                )?;
            }
        }
        conn.execute("INSERT INTO schema_migrations (version) VALUES (2)", [])?;
    }

    // Migration 3: Add is_external
    if current_version < 3 {
        if !has_column(conn, "clipboard_history", "is_external")? {
            conn.execute(
                "ALTER TABLE clipboard_history ADD COLUMN is_external INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        conn.execute("INSERT INTO schema_migrations (version) VALUES (3)", [])?;
    }

    // Migration 4: Tag management
    if current_version < 4 {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS saved_tags (
                name TEXT PRIMARY KEY,
                color TEXT
            )",
            [],
        )?;

        // Insert default tags
        let _ = conn.execute(
            "INSERT OR IGNORE INTO saved_tags (name) VALUES ('sensitive')",
            [],
        );
        let _ = conn.execute(
            "INSERT OR IGNORE INTO saved_tags (name) VALUES ('密码')",
            [],
        );

        conn.execute("INSERT INTO schema_migrations (version) VALUES (4)", [])?;
    }

    // Migration 5: Performance indexes
    if current_version < 5 {
        conn.execute_batch(
            "
            CREATE INDEX IF NOT EXISTS idx_clipboard_history_pinned_order_time
                ON clipboard_history (is_pinned, pinned_order, timestamp);
            CREATE INDEX IF NOT EXISTS idx_clipboard_history_type_hash
                ON clipboard_history (content_type, content_hash);
            CREATE INDEX IF NOT EXISTS idx_clipboard_history_timestamp
                ON clipboard_history (timestamp);
        ",
        )?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (5)", [])?;
    }

    // Migration 6: Normalize tags into entry_tags
    if current_version < 6 {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS entry_tags (
                entry_id INTEGER NOT NULL,
                tag TEXT NOT NULL,
                PRIMARY KEY (entry_id, tag)
            );
            CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags (tag);
            CREATE INDEX IF NOT EXISTS idx_entry_tags_entry ON entry_tags (entry_id);
        ",
        )?;

        // Backfill entry_tags from clipboard_history.tags JSON
        conn.execute("BEGIN", [])?;
        let backfill = (|| -> Result<()> {
            let mut stmt = conn.prepare("SELECT id, tags FROM clipboard_history")?;
            let rows = stmt.query_map([], |row| {
                let id: i64 = row.get(0)?;
                let tags: Option<String> = row.get(1)?;
                Ok((id, tags.unwrap_or_else(|| "[]".to_string())))
            })?;

            for row in rows {
                let (id, tags_json) = row?;
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                for tag in tags {
                    if tag.trim().is_empty() {
                        continue;
                    }
                    conn.execute(
                        "INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?1, ?2)",
                        params![id, tag],
                    )?;
                }
            }
            Ok(())
        })();

        if let Err(err) = backfill {
            let _ = conn.execute("ROLLBACK", []);
            return Err(err);
        }
        conn.execute("COMMIT", [])?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (6)", [])?;
    }

    // Migration 7: Cloud sync tombstones for deletion propagation
    if current_version < 7 {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS cloud_sync_tombstones (
                content_type TEXT NOT NULL,
                content_hash INTEGER NOT NULL,
                deleted_at INTEGER NOT NULL,
                PRIMARY KEY (content_type, content_hash)
            );
            CREATE INDEX IF NOT EXISTS idx_cloud_sync_tombstones_deleted_at
                ON cloud_sync_tombstones (deleted_at);
            ",
        )?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (7)", [])?;
    }

    // Migration 8: Local incremental sync index (for delta diff against last uploaded state)
    if current_version < 8 {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS cloud_sync_local_index (
                sync_key TEXT PRIMARY KEY,
                digest TEXT NOT NULL
            );
            ",
        )?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (8)", [])?;
    }

    // Migration 9: Persist source app path for source icon rendering
    if current_version < 9 {
        if !has_column(conn, "clipboard_history", "source_app_path")? {
            conn.execute(
                "ALTER TABLE clipboard_history ADD COLUMN source_app_path TEXT",
                [],
            )?;
        }
        conn.execute("INSERT INTO schema_migrations (version) VALUES (9)", [])?;
    }

    // Migration 10: Cloud sync content type preferences (per-device; not synced in settings snapshot)
    if current_version < 10 {
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('cloud_sync_content_prefs', '{\"text\":true,\"image\":true,\"file_path\":true,\"emoji\":true}')",
            [],
        )?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (10)", [])?;
    }

    // Migration 11: Official auto-classification tags (网站/手机号/邮箱/apikey/网盘)
    if current_version < 11 {
        for tag in crate::services::auto_tag::OFFICIAL_AUTO_TAGS {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO saved_tags (name) VALUES (?1)",
                params![tag],
            )?;
        }
        conn.execute("INSERT INTO schema_migrations (version) VALUES (11)", [])?;
    }

    // Migration 12: FTS5 trigram index for fast substring search (including CJK)
    //
    // The default `unicode61` tokenizer cannot split Chinese text, so matching a
    // Chinese substring was only possible with `LIKE '%term%'`, which scans every
    // row. A trigram index answers arbitrary substring queries from the index
    // instead of scanning, and works for CJK. Triggers mirror every
    // `clipboard_history` write into the index, so all existing write paths
    // (save / delete / clear / enforce_limit / encrypt / decrypt) stay indexed
    // without being touched.
    //
    // If FTS5 is unavailable the migration is left unrecorded so it is retried on
    // the next launch, and `search` keeps using its LIKE fallback.
    if current_version < 12 {
        #[cfg(not(feature = "portable"))]
        if let Err(err) = create_search_index(conn) {
            error!("[FTS] trigram index unavailable, search falls back to LIKE: {}", err);
            return Ok(());
        }
        conn.execute("INSERT INTO schema_migrations (version) VALUES (12)", [])?;
    }

    // Migration 13: Cache each tombstone's sync digest so delta rounds can skip settled rows.
    //
    // A tombstone's digest is a pure function of (content_type, content_hash, deleted_at), all
    // immutable once the row exists, so 14k+ tombstones re-hash to the same value on every sync
    // round. `digest` stores that value; `indexed_digest` stores the digest of the deletion that
    // has actually been pushed (it mirrored the index row until migration 14 dropped those), so a
    // row is "settled" when digest = indexed_digest and can be skipped by
    // `collect_local_delta_view` without touching the index. `sync_key` is the
    // `content_type || ':' || content_hash` form of the index key used to relate a tombstone to the
    // index row it shadows (migration 14 removes those rows; this migration's anti-join shaped read
    // was dropped there because the anti-join cost more than the rows it filtered).
    //
    // Every writer that changes or recreates a row must clear `digest`/`indexed_digest`, and any
    // code that clears `cloud_sync_local_index` must clear `indexed_digest`, otherwise settled
    // tombstones would never be re-offered and deleted items could come back from the remote.
    if current_version < 13 {
        for (name, def) in [
            ("sync_key", "TEXT"),
            ("digest", "TEXT"),
            ("indexed_digest", "TEXT"),
        ] {
            if !has_column(conn, "cloud_sync_tombstones", name)? {
                conn.execute(
                    &format!("ALTER TABLE cloud_sync_tombstones ADD COLUMN {} {}", name, def),
                    [],
                )?;
            }
        }
        conn.execute(
            "UPDATE cloud_sync_tombstones
             SET sync_key = content_type || ':' || content_hash
             WHERE sync_key IS NULL",
            [],
        )?;
        // Covering index for the index-read anti-join: it probes one key at a time and filters on
        // both digest columns, so carrying them in the index keeps the probe index-only.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_cloud_sync_tombstones_sync_key
                ON cloud_sync_tombstones (sync_key, digest, indexed_digest)",
            [],
        )?;
        // Partial index over the unsettled rows only: the delta view asks for exactly this
        // predicate, so with the index it reads the handful of pending rows instead of scanning
        // all 14k tombstones every round. The column order also serves the view's
        // `ORDER BY deleted_at`, and covers every column the view selects.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_cloud_sync_tombstones_pending
                ON cloud_sync_tombstones (deleted_at, content_type, content_hash, digest)
                WHERE digest IS NULL OR indexed_digest IS NULL OR digest <> indexed_digest",
            [],
        )?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (13)", [])?;
    }

    // Migration 14: keep tombstone keys out of `cloud_sync_local_index`.
    //
    // A tombstone already carries its own push state (`digest` / `indexed_digest` from migration 13,
    // mirrored into the index by `cache_tombstone_digests`), so an index row for it is redundant.
    // On the live store 14355 of the 16373 index rows were exactly that, and every round had to
    // anti-join them away in `load_local_sync_index` - measured at ~15ms, i.e. more than the ~7ms
    // full read it filtered. Rows shadowed by an *already settled* tombstone are therefore removed
    // here: their state survives in the columns, which hold the very digest the index held.
    //
    // Rows shadowed by an *unsettled* tombstone are deliberately left alone: settling those from the
    // index (without an upload) is what keeps an upgrade from 0.4.6 and earlier from re-uploading
    // ~14k deletion deltas. `collect_local_incremental_items` settles and removes them in the first
    // round, and never writes an index row for a tombstone again.
    if current_version < 14 {
        conn.execute(
            "DELETE FROM cloud_sync_local_index
              WHERE sync_key IN (
                  SELECT sync_key FROM cloud_sync_tombstones
                   WHERE sync_key IS NOT NULL
                     AND digest IS NOT NULL
                     AND indexed_digest = digest
              )",
            [],
        )?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (14)", [])?;
    }

    // Migration 15: Composition tags for content no category tag matched
    // (纯数字 / 纯字母 / 数字字母). Classification only, never "sensitive".
    if current_version < 15 {
        // A store that skipped migration 4 (hand-made/partial schemas, tests) has no saved_tags
        // yet, and the tag list below is the only thing that needs it.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS saved_tags (
                name TEXT PRIMARY KEY,
                color TEXT
            )",
            [],
        )?;
        for tag in crate::services::auto_tag::COMPOSITION_TAGS {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO saved_tags (name) VALUES (?1)",
                params![tag],
            )?;
        }
        conn.execute("INSERT INTO schema_migrations (version) VALUES (15)", [])?;
    }

    Ok(())
}

/// Create the FTS5 trigram index backing `ClipboardRepository::search`.
///
/// `content='clipboard_history'` makes this an external-content index: the row
/// text is not duplicated, only the trigram index is stored. `content_rowid`
/// keeps the FTS rowid equal to `clipboard_history.id` so search can join back
/// on the primary key.
///
/// On any failure the partial index is dropped, because an index that exists but
/// was never backfilled would make searches silently return nothing instead of
/// falling back to LIKE.
///
/// The `portable` build deliberately stays on plain LIKE, so it skips this.
#[cfg(not(feature = "portable"))]
fn create_search_index(conn: &Connection) -> Result<()> {
    let built = (|| -> Result<()> {
        conn.execute_batch(
            "
            CREATE VIRTUAL TABLE IF NOT EXISTS clipboard_fts USING fts5(
                content,
                source_app,
                tags,
                content='clipboard_history',
                content_rowid='id',
                tokenize='trigram'
            );

            CREATE TRIGGER IF NOT EXISTS clipboard_history_fts_ai
            AFTER INSERT ON clipboard_history BEGIN
                INSERT INTO clipboard_fts(rowid, content, source_app, tags)
                VALUES (new.id, new.content, new.source_app, new.tags);
            END;

            CREATE TRIGGER IF NOT EXISTS clipboard_history_fts_ad
            AFTER DELETE ON clipboard_history BEGIN
                INSERT INTO clipboard_fts(clipboard_fts, rowid, content, source_app, tags)
                VALUES ('delete', old.id, old.content, old.source_app, old.tags);
            END;

            CREATE TRIGGER IF NOT EXISTS clipboard_history_fts_au
            AFTER UPDATE ON clipboard_history BEGIN
                INSERT INTO clipboard_fts(clipboard_fts, rowid, content, source_app, tags)
                VALUES ('delete', old.id, old.content, old.source_app, old.tags);
                INSERT INTO clipboard_fts(rowid, content, source_app, tags)
                VALUES (new.id, new.content, new.source_app, new.tags);
            END;
            ",
        )?;

        // Backfill rows that already existed before the index was created.
        conn.execute(
            "INSERT INTO clipboard_fts(clipboard_fts) VALUES ('rebuild')",
            [],
        )?;
        Ok(())
    })();

    if built.is_err() {
        let _ = conn.execute_batch(
            "
            DROP TRIGGER IF EXISTS clipboard_history_fts_ai;
            DROP TRIGGER IF EXISTS clipboard_history_fts_ad;
            DROP TRIGGER IF EXISTS clipboard_history_fts_au;
            DROP TABLE IF EXISTS clipboard_fts;
            ",
        );
    }

    built
}

fn has_column(conn: &Connection, table_name: &str, column_name: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table_name))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column_name {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(all(test, not(feature = "portable")))]
mod tests {
    use super::*;

    fn count_matches(conn: &Connection, term: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM clipboard_fts
             JOIN clipboard_history ch ON ch.id = clipboard_fts.rowid
             WHERE clipboard_fts MATCH ?1",
            params![format!("\"{}\"", term)],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn search_index_backfills_rows_that_predate_it() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE clipboard_history (
                id INTEGER PRIMARY KEY,
                content_type TEXT NOT NULL,
                content TEXT NOT NULL,
                source_app TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                preview TEXT NOT NULL,
                tags TEXT NOT NULL DEFAULT '[]'
            );
            INSERT INTO clipboard_history
                (id, content_type, content, source_app, timestamp, preview, tags)
            VALUES
                (1, 'text', '历史数据 中文子串检索', 'Code.exe', 1, 'p', '[]'),
                (2, 'text', 'legacy ascii row', 'msedge.exe', 2, 'p', '[]');
            ",
        )
        .unwrap();

        create_search_index(&conn).unwrap();

        assert_eq!(
            count_matches(&conn, "中文子串"),
            1,
            "rebuild must index rows that existed before the index was created"
        );
        assert_eq!(count_matches(&conn, "legacy"), 1);

        conn.execute(
            "INSERT INTO clipboard_history
                (id, content_type, content, source_app, timestamp, preview, tags)
             VALUES (3, 'text', '新增行 触发器同步', 'Code.exe', 3, 'p', '[]')",
            [],
        )
        .unwrap();
        assert_eq!(
            count_matches(&conn, "触发器同步"),
            1,
            "AFTER INSERT trigger must index new rows"
        );

        conn.execute("DELETE FROM clipboard_history WHERE id = 2", [])
            .unwrap();
        assert_eq!(
            count_matches(&conn, "legacy"),
            0,
            "AFTER DELETE trigger must drop rows from the index"
        );
    }
}

/// Migrations 13 and 14 need their own module: the one above is
/// `#[cfg(all(test, not(feature = "portable")))]` and this crate's tests are normally run with
/// `--features portable`.
#[cfg(test)]
mod tombstone_digest_cache_migration_tests {
    use super::*;

    /// The pre-13 shape: tombstones without the digest cache, already at schema version 12.
    fn legacy_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
            INSERT INTO schema_migrations (version) VALUES (12);
            CREATE TABLE cloud_sync_tombstones (
                content_type TEXT NOT NULL,
                content_hash INTEGER NOT NULL,
                deleted_at INTEGER NOT NULL,
                PRIMARY KEY (content_type, content_hash)
            );
            INSERT INTO cloud_sync_tombstones (content_type, content_hash, deleted_at)
            VALUES ('text', 42, 1234), ('rich_text', 3626756920440216531, 1791467867542);
            CREATE TABLE cloud_sync_local_index (
                sync_key TEXT PRIMARY KEY,
                digest TEXT NOT NULL
            );
            ",
        )
        .unwrap();
        conn
    }

    /// The 0.4.7 shape, i.e. schema version 13: tombstones carry the digest cache and their keys
    /// still have rows in `cloud_sync_local_index`.
    fn v13_db() -> Connection {
        let conn = legacy_db();
        conn.execute_batch(
            "
            ALTER TABLE cloud_sync_tombstones ADD COLUMN sync_key TEXT;
            ALTER TABLE cloud_sync_tombstones ADD COLUMN digest TEXT;
            ALTER TABLE cloud_sync_tombstones ADD COLUMN indexed_digest TEXT;
            UPDATE cloud_sync_tombstones
               SET sync_key = content_type || ':' || content_hash;
            -- Settled: the index already recorded this deletion.
            UPDATE cloud_sync_tombstones
               SET digest = 'digest-a', indexed_digest = 'digest-a'
             WHERE content_type = 'text';
            INSERT INTO cloud_sync_local_index (sync_key, digest)
            VALUES ('text:42', 'digest-a'), ('rich_text:3626756920440216531', 'stale');
            DELETE FROM schema_migrations WHERE version = 12;
            INSERT INTO schema_migrations (version) VALUES (13);
            ",
        )
        .unwrap();
        conn
    }

    #[test]
    fn migration_14_drops_index_rows_for_settled_tombstones_only() {
        let conn = v13_db();
        run_migrations(&conn).unwrap();

        let rows: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT sync_key FROM cloud_sync_local_index ORDER BY sync_key")
                .unwrap();
            let mapped = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
            mapped.map(|row| row.unwrap()).collect()
        };
        // The settled tombstone's row is redundant (its state lives on the row); the unsettled one
        // must survive, because settling it from the index is what keeps the first round after an
        // upgrade from re-uploading every deletion.
        assert_eq!(rows, vec!["rich_text:3626756920440216531".to_string()]);

        // The settled columns are untouched, so no tombstone becomes pending again.
        let settled: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cloud_sync_tombstones
                  WHERE digest IS NOT NULL AND indexed_digest = digest",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(settled, 1);

        run_migrations(&conn).unwrap();
        let max_version: i32 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(max_version, 15);
    }

    #[test]
    fn migration_13_adds_and_backfills_the_tombstone_digest_cache() {
        let conn = legacy_db();
        run_migrations(&conn).unwrap();

        for column in ["sync_key", "digest", "indexed_digest"] {
            assert!(
                has_column(&conn, "cloud_sync_tombstones", column).unwrap(),
                "migration 13 must add cloud_sync_tombstones.{column}"
            );
        }

        // `sync_key` has to stay byte-identical to Rust's `sync_key_for_item`/`LocalIndexUpdate`
        // format, otherwise settled tombstones would shadow the wrong index rows.
        let key: String = conn
            .query_row(
                "SELECT sync_key FROM cloud_sync_tombstones WHERE content_type = 'text'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(key, "text:42");

        // Real hashes are full-width i64 values; the TEXT column must hold them verbatim.
        let big: String = conn
            .query_row(
                "SELECT sync_key FROM cloud_sync_tombstones WHERE content_type = 'rich_text'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(big, "rich_text:3626756920440216531");

        // A fresh cache starts empty, so the first round re-derives every digest once and settles it.
        let cached: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cloud_sync_tombstones
                 WHERE digest IS NOT NULL OR indexed_digest IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cached, 0);

        // Without the partial index the delta view would scan all 14k tombstones every round.
        let pending_index: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_cloud_sync_tombstones_pending'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending_index, 1, "the unsettled-tombstone partial index is required");

        // Re-running must be a no-op: existing columns are kept, version 13 is recorded once.
        run_migrations(&conn).unwrap();
        let max_version: i32 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(max_version, 15);
        let thirteen: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 13",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(thirteen, 1);
    }

    /// Migration 15 must seed the composition tags even on a store whose saved_tags came from the
    /// migration-11 seed list only, otherwise the tag panel has no row to show before the first
    /// alignment pass writes entry_tags.
    #[test]
    fn migration_15_seeds_composition_tags() {
        let conn = legacy_db();
        run_migrations(&conn).unwrap();

        for tag in ["纯数字", "纯字母", "数字字母"] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM saved_tags WHERE name = ?1",
                    params![tag],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "migration 15 must seed saved_tags.{tag}");
        }

        // Re-running keeps exactly one row per tag.
        run_migrations(&conn).unwrap();
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM saved_tags", [], |row| row.get(0))
            .unwrap();
        assert_eq!(total, 3);
    }
}
