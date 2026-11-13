use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::database::{DbState, ENCRYPT_PREFIX, has_sensitive_tag, is_text_type};
use crate::infrastructure::repository::settings_repo::SettingsRepository;
use crate::services::auto_tag::{OFFICIAL_AUTO_TAGS, classify_auto_tags, is_system_tag};

/// Bump when classification rules change materially so the realignment runs
/// once more over the whole history.
///
/// v3: composition tags (纯数字/纯字母/数字字母) added for unrecognized content.
/// v4: shape tags (长文本/AI提示词) so existing history can be filtered by them
///     instead of only the entries captured after the upgrade.
/// v5: the prompt rule now requires its ask in the opening stretch; v4 had
///     already been written by the time that tightened, so it runs again.
const REALIGNMENT_FLAG: &str = "db.auto_tag_realignment_v5_done";

/// One-time realignment over the entire history: re-run classification with
/// the current rules, add missing official tags ("sensitive" is the superset
/// every category tag implies), drop category tags the current rules no longer
/// produce, and keep the dpapi encryption in sync with the final tag set
/// (decrypt to classify, re-encrypt entries that stay sensitive). New entries
/// are tagged live by the capture pipeline; this pass only fixes legacy data.
pub fn spawn_auto_tag_alignment(app_handle: AppHandle) {
    thread::spawn(move || run_alignment(app_handle));
}

fn run_alignment(app_handle: AppHandle) {
    let db_state = app_handle.state::<DbState>();
    let done = db_state
        .settings_repo
        .get(REALIGNMENT_FLAG)
        .unwrap_or(None)
        .unwrap_or_else(|| "false".to_string());
    if done == "true" {
        return;
    }

    // Give startup (clipboard listener, migrations) a moment to settle.
    thread::sleep(Duration::from_millis(2000));

    let mut cursor_ts = i64::MAX;
    let mut cursor_id = i64::MAX;
    let batch_size = 200;
    let mut updated_count = 0usize;

    loop {
        let conn_guard = match db_state.conn.lock() {
            Ok(c) => c,
            Err(_) => {
                thread::sleep(Duration::from_millis(50));
                continue;
            }
        };

        let sql = "SELECT ch.id, ch.timestamp, ch.content_type, ch.content, ch.tags
             FROM clipboard_history ch
             WHERE (ch.timestamp < ?1) OR (ch.timestamp = ?1 AND ch.id < ?2)
             ORDER BY ch.timestamp DESC, ch.id DESC
             LIMIT ?3";

        let mut batch: Vec<(i64, i64, String, String, String)> = Vec::new();
        {
            let mut stmt = match conn_guard.prepare(sql) {
                Ok(s) => s,
                Err(_) => break,
            };

            let rows = match stmt.query_map([cursor_ts, cursor_id, batch_size], |row| {
                let id: i64 = row.get(0)?;
                let ts: i64 = row.get(1)?;
                let content_type: String = row.get(2)?;
                let content: String = row.get(3)?;
                let tags_json: String = row.get(4)?;
                Ok((id, ts, content_type, content, tags_json))
            }) {
                Ok(r) => r,
                Err(_) => break,
            };

            for row in rows {
                if let Ok(item) = row {
                    batch.push(item);
                }
            }
        }

        if batch.is_empty() {
            break;
        }

        for (id, _ts, content_type, content, tags_json) in batch.iter() {
            if !is_text_type(content_type) || content.starts_with("data:") {
                continue;
            }
            let existing_tags: Vec<String> =
                serde_json::from_str(tags_json).unwrap_or_default();

            // Entries already carrying a category tag plus "sensitive" were
            // tagged by the current rules and are encrypted; re-deriving their
            // tags would require a pointless decrypt/encrypt round trip.
            // Trade-off: such an entry also misses the shape tags (长文本 /
            // AI提示词). Secret-bearing entries are short tokens far more often
            // than documents, and everything captured from now on is classified
            // live by the capture pipeline, so the skip stays.
            let has_category = existing_tags
                .iter()
                .any(|t| OFFICIAL_AUTO_TAGS.iter().any(|o| o.eq_ignore_ascii_case(t)));
            let has_sensitive = existing_tags
                .iter()
                .any(|t| t.eq_ignore_ascii_case("sensitive"));
            if has_category && has_sensitive && content.starts_with(ENCRYPT_PREFIX) {
                continue;
            }

            // Classification needs plaintext; decrypt now, re-encrypt below.
            let mut decrypted = false;
            let plaintext = if content.starts_with(ENCRYPT_PREFIX) {
                match db_state.repo.decrypt_entry_with_conn(&conn_guard, *id) {
                    Ok(()) => {
                        decrypted = true;
                        match conn_guard.query_row(
                            "SELECT content FROM clipboard_history WHERE id = ?1",
                            rusqlite::params![id],
                            |row| row.get::<usize, String>(0),
                        ) {
                            Ok(v) => v,
                            Err(_) => continue,
                        }
                    }
                    Err(_) => continue,
                }
            } else {
                content.clone()
            };

            let desired = classify_auto_tags(&plaintext, content_type);

            // Category tags are system-owned: drop the ones the current rules
            // no longer produce (composition tags included). "sensitive" and
            // user tags are never removed.
            let mut merged: Vec<String> = existing_tags
                .iter()
                .filter(|t| !is_system_tag(t) || desired.iter().any(|d| d.eq_ignore_ascii_case(t)))
                .cloned()
                .collect();
            let mut added: Vec<String> = Vec::new();
            let mut removed: Vec<String> = Vec::new();
            for tag in &desired {
                if !merged.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
                    merged.push(tag.clone());
                    added.push(tag.clone());
                }
            }
            for tag in &existing_tags {
                if is_system_tag(tag) && !merged.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
                    removed.push(tag.clone());
                }
            }

            // A decrypted entry must be re-encrypted even when its tags end up
            // unchanged (it stays sensitive).
            let mut changed = decrypted;
            if !added.is_empty() || !removed.is_empty() {
                changed = true;
            }
            if !changed {
                continue;
            }

            if let Ok(json) = serde_json::to_string(&merged) {
                let _ = conn_guard.execute(
                    "UPDATE clipboard_history SET tags = ?1 WHERE id = ?2",
                    rusqlite::params![json, id],
                );
                for tag in &added {
                    let _ = conn_guard.execute(
                        "INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?1, ?2)",
                        rusqlite::params![id, tag],
                    );
                }
                for tag in &removed {
                    let _ = conn_guard.execute(
                        "DELETE FROM entry_tags WHERE entry_id = ?1 AND tag = ?2",
                        rusqlite::params![id, tag],
                    );
                }
                updated_count += 1;

                let final_content: String = conn_guard
                    .query_row(
                        "SELECT content FROM clipboard_history WHERE id = ?1",
                        rusqlite::params![id],
                        |row| row.get(0),
                    )
                    .unwrap_or_default();
                if has_sensitive_tag(&merged) && !final_content.starts_with(ENCRYPT_PREFIX) {
                    let _ = db_state.repo.encrypt_entry_with_conn(&conn_guard, *id);
                }
            }
        }

        if let Some((id, ts, _, _, _)) = batch.last() {
            cursor_ts = *ts;
            cursor_id = *id;
        } else {
            break;
        }

        drop(conn_guard);
        thread::sleep(Duration::from_millis(50));
    }

    let _ = db_state
        .settings_repo
        .set(REALIGNMENT_FLAG, "true");

    if updated_count > 0 {
        let _ = app_handle.emit("clipboard-changed", ());
    }
}
