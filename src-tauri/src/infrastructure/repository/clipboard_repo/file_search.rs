use super::SqliteClipboardRepository;
use crate::domain::models::ClipboardEntry;
use std::collections::HashSet;

fn matches_extensions(kind: &str, content: &str, extensions: &[String]) -> bool {
    if !matches!(kind, "file" | "image" | "video") {
        return false;
    }
    content.lines().any(|path| {
        let name = path
            .trim()
            .trim_matches('"')
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or("")
            .to_lowercase();
        extensions
            .iter()
            .any(|ext| name.ends_with(&format!(".{}", ext)))
    })
}

impl SqliteClipboardRepository {
    /// File bodies may be encrypted, so match decoded paths before taking a page.
    pub fn search_file_page(
        &self,
        query: &str,
        tag_only: bool,
        extensions: &[String],
        limit: usize,
        offset: usize,
        session: &[ClipboardEntry],
    ) -> Result<Vec<ClipboardEntry>, String> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let extensions: Vec<String> = extensions
            .iter()
            .map(|ext| {
                ext.trim()
                    .trim_start_matches("*.")
                    .trim_start_matches('.')
                    .to_lowercase()
            })
            .filter(|ext| !ext.is_empty())
            .collect();
        let term = query.trim().to_lowercase();
        let matches = |kind: &str, content: &str, source: &str, tags: &[String]| {
            matches_extensions(kind, content, &extensions)
                && (term.is_empty()
                    || tags.iter().any(|tag| tag.to_lowercase().contains(&term))
                    || (!tag_only
                        && (content.to_lowercase().contains(&term)
                            || source.to_lowercase().contains(&term))))
        };
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut candidates = Vec::new();
        let mut seen = HashSet::new();
        {
            let mut stmt = tx.prepare("SELECT id, timestamp, is_pinned, pinned_order, content_type, content, source_app, tags
                FROM clipboard_history WHERE content_type IN ('file', 'image', 'video')").map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, bool>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (id, timestamp, pinned, order, kind, raw, source, tags) =
                    row.map_err(|e| e.to_string())?;
                let content = self.maybe_decrypt_text(&raw);
                let tags: Vec<String> = serde_json::from_str(&tags).map_err(|e| e.to_string())?;
                if matches(&kind, &content, &source, &tags) {
                    seen.insert(id);
                    candidates.push((id, timestamp, pinned, order, None));
                }
            }
        }
        for (index, item) in session.iter().enumerate() {
            if matches(
                &item.content_type,
                &item.content,
                &item.source_app,
                &item.tags,
            ) && (item.id == 0 || seen.insert(item.id))
            {
                candidates.push((
                    item.id,
                    item.timestamp,
                    item.is_pinned,
                    item.pinned_order,
                    Some(index),
                ));
            }
        }
        candidates.sort_by(|a, b| {
            b.2.cmp(&a.2)
                .then_with(|| {
                    if a.2 && b.2 {
                        b.3.cmp(&a.3)
                    } else {
                        std::cmp::Ordering::Equal
                    }
                })
                .then_with(|| b.1.cmp(&a.1))
                .then_with(|| b.0.cmp(&a.0))
                .then_with(|| b.4.cmp(&a.4))
        });
        let mut result = Vec::new();
        for (id, _, _, _, index) in candidates.into_iter().skip(offset).take(limit) {
            result.push(if let Some(index) = index {
                session[index].clone()
            } else {
                self.get_entry_by_id_with_conn(&tx, id)?
                    .ok_or_else(|| "File result disappeared within read snapshot".to_string())?
            });
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::repository::{
        clipboard_repo::ClipboardRepository, migrations::run_migrations,
    };
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    fn entry(n: usize, kind: &str, content: String) -> ClipboardEntry {
        ClipboardEntry {
            id: 0,
            content_type: kind.into(),
            content,
            html_content: None,
            source_app: "Explorer".into(),
            source_app_path: None,
            timestamp: n as i64,
            preview: "file".into(),
            is_pinned: false,
            tags: vec!["Work".into()],
            use_count: 0,
            is_external: false,
            pinned_order: 0,
            file_preview_exists: true,
        }
    }

    #[test]
    fn file_format_paths_are_literal_case_insensitive_and_support_batches() {
        let pdf = vec!["pdf".into()];
        assert!(matches_extensions(
            "file",
            "C:\\A.TXT\r\n\"C:\\报告.PDF\"",
            &pdf
        ));
        assert!(!matches_extensions("text", "C:\\a.pdf", &pdf));
        assert!(!matches_extensions("file", "C:\\a.pdf\\b.txt", &pdf));
        assert!(!matches_extensions("file", "C:\\a.pdf.bak", &pdf));
        assert!(matches_extensions(
            "file",
            "/tmp/a.tar.gz",
            &["tar.gz".into()]
        ));
    }

    #[test]
    fn file_format_filters_before_pagination_and_merges_session() {
        let conn = Connection::open_in_memory().unwrap();
        run_migrations(&conn).unwrap();
        let repo = SqliteClipboardRepository::new(Arc::new(Mutex::new(conn)));
        for n in 0..261 {
            repo.save(&entry(n, "file", format!("C:\\report-{n}.PDF")), None)
                .unwrap();
            repo.save(
                &entry(n + 1000, "text", format!("not a file {n}.pdf")),
                None,
            )
            .unwrap();
        }
        let session = vec![
            entry(5000, "file", "C:\\transient.pdf".into()),
            entry(5001, "file", "C:\\transient2.pdf".into()),
        ];
        let mut ids = Vec::new();
        for offset in (0..300).step_by(37) {
            let page = repo
                .search_file_page(" work ", true, &["PDF".into()], 37, offset, &session)
                .unwrap();
            ids.extend(page.into_iter().map(|item| item.id));
        }
        assert_eq!(ids.len(), 263);
        assert_eq!(ids.iter().filter(|id| **id == 0).count(), 2);
        assert_eq!(
            ids.iter()
                .filter(|id| **id != 0)
                .collect::<HashSet<_>>()
                .len(),
            261
        );
        assert_eq!(
            repo.search_file_page("report-260", false, &["pdf".into()], 10, 0, &session)
                .unwrap()
                .len(),
            1
        );
        assert!(repo
            .search_file_page("absent", true, &["pdf".into()], 10, 0, &session)
            .unwrap()
            .is_empty());
    }
}
