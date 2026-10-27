use super::SqliteClipboardRepository;
use crate::domain::models::ClipboardEntry;
use rusqlite::params;
use std::collections::HashSet;

struct Candidate {
    id: i64,
    timestamp: i64,
    pinned: bool,
    pinned_order: i64,
    session_index: Option<usize>,
}

impl SqliteClipboardRepository {
    /// Match authoritative tag metadata before pagination. This includes encrypted
    /// records without decrypting every body, and treats SQL wildcard characters
    /// literally. Only the selected page's bodies are loaded/decrypted.
    pub fn search_tag_page(
        &self,
        query: &str,
        limit: usize,
        offset: usize,
        content_type: Option<&str>,
        session: &[ClipboardEntry],
    ) -> Result<Vec<ClipboardEntry>, String> {
        let term = query.trim().to_lowercase();
        if term.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Keep metadata selection and body loading on the same read snapshot.
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        {
            let mut stmt = tx
                .prepare(
                    "SELECT id, timestamp, is_pinned, pinned_order, tags FROM clipboard_history
                 WHERE (?1 IS NULL OR content_type = ?1)",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![content_type], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, bool>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (id, timestamp, pinned, pinned_order, tags_json) =
                    row.map_err(|e| e.to_string())?;
                // Corruption is an error, never silently reported as no matches.
                let tags: Vec<String> =
                    serde_json::from_str(&tags_json).map_err(|e| e.to_string())?;
                if tags.iter().any(|tag| tag.to_lowercase().contains(&term)) {
                    seen.insert(id);
                    candidates.push(Candidate {
                        id,
                        timestamp,
                        pinned,
                        pinned_order,
                        session_index: None,
                    });
                }
            }
        }
        for (index, item) in session.iter().enumerate() {
            if content_type.is_some_and(|kind| item.content_type != kind)
                || !item
                    .tags
                    .iter()
                    .any(|tag| tag.to_lowercase().contains(&term))
            {
                continue;
            }
            // id=0 records are distinct transient entries, not duplicate identities.
            if item.id != 0 && !seen.insert(item.id) {
                continue;
            }
            candidates.push(Candidate {
                id: item.id,
                timestamp: item.timestamp,
                pinned: item.is_pinned,
                pinned_order: item.pinned_order,
                session_index: Some(index),
            });
        }
        candidates.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| {
                    if a.pinned && b.pinned {
                        b.pinned_order.cmp(&a.pinned_order)
                    } else {
                        std::cmp::Ordering::Equal
                    }
                })
                .then_with(|| b.timestamp.cmp(&a.timestamp))
                .then_with(|| b.id.cmp(&a.id))
                .then_with(|| b.session_index.cmp(&a.session_index))
        });
        let mut result = Vec::new();
        for candidate in candidates.into_iter().skip(offset).take(limit) {
            if let Some(index) = candidate.session_index {
                result.push(session[index].clone());
            } else {
                let item = self
                    .get_entry_by_id_with_conn(&tx, candidate.id)?
                    .ok_or_else(|| "Tag result disappeared within read snapshot".to_string())?;
                result.push(item);
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::repository::clipboard_repo::ClipboardRepository;
    use crate::infrastructure::repository::migrations::run_migrations;
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    fn repo() -> SqliteClipboardRepository {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        SqliteClipboardRepository::new(Arc::new(Mutex::new(conn)))
    }
    fn entry(n: usize, tags: &[&str]) -> ClipboardEntry {
        ClipboardEntry {
            id: 0,
            content_type: "text".into(),
            content: format!("unique payload {n}"),
            html_content: None,
            source_app: "test".into(),
            source_app_path: None,
            timestamp: n as i64,
            preview: format!("preview {n}"),
            is_pinned: false,
            tags: tags.iter().map(|s| s.to_string()).collect(),
            use_count: 0,
            is_external: false,
            pinned_order: 0,
            file_preview_exists: true,
        }
    }
    #[test]
    fn tag_pages_cover_more_than_200_and_sensitive_records() {
        let repo = repo();
        let mut expected = HashSet::new();
        for n in 0..261 {
            let tags = if n % 2 == 0 {
                vec!["工作", "sensitive"]
            } else {
                vec!["工作"]
            };
            expected.insert(repo.save(&entry(n, &tags), None).unwrap());
        }
        let mut actual = Vec::new();
        for offset in (0..300).step_by(37) {
            let page = repo.search_tag_page("工作", 37, offset, None, &[]).unwrap();
            actual.extend(page.into_iter().map(|item| item.id));
        }
        assert_eq!(actual.len(), 261);
        assert_eq!(actual.into_iter().collect::<HashSet<_>>(), expected);
    }
    #[test]
    fn tag_type_filter_precedes_limit_and_session_merge() {
        let repo = repo();
        for n in 0..205 {
            repo.save(&entry(n, &["Work"]), None).unwrap();
        }
        let mut image = entry(999, &["Work"]);
        image.content_type = "code".into();
        let id = repo.save(&image, None).unwrap();
        let mut transient = entry(1000, &["WORK"]);
        transient.content_type = "code".into();
        transient.is_pinned = true;
        let session = vec![transient.clone(), transient];
        let page = repo
            .search_tag_page(" work ", 10, 0, Some("code"), &session)
            .unwrap();
        assert_eq!(page.len(), 3);
        assert_eq!(page[0].id, 0);
        assert_eq!(page[1].id, 0);
        assert_eq!(page[2].id, id);
        let persisted = repo.get_entry_by_id(id).unwrap().unwrap();
        assert_eq!(
            repo.search_tag_page("work", 10, 0, Some("code"), &[persisted])
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn tag_matching_is_unicode_literal_and_independent_of_tag_index() {
        let repo = repo();
        let id = repo.save(&entry(1, &["ÉQUIPE_100%"]), None).unwrap();
        repo.save(&entry(2, &["EQUIPE_100X"]), None).unwrap();
        // The JSON tags remain authoritative even if the auxiliary join table is stale.
        repo.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM entry_tags WHERE entry_id = ?", params![id])
            .unwrap();
        for term in ["équipe", "100%", "_100%"] {
            let page = repo.search_tag_page(term, 10, 0, None, &[]).unwrap();
            assert_eq!(page.len(), 1);
            assert_eq!(page[0].id, id);
        }
        assert!(repo
            .search_tag_page("absent", 10, 0, None, &[])
            .unwrap()
            .is_empty());
        assert!(repo
            .search_tag_page("équipe", 10, 99, None, &[])
            .unwrap()
            .is_empty());
    }
}
