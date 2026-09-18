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
