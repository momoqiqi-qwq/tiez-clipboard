use crate::database::DbState;
use crate::error::{AppError, AppResult};
use crate::infrastructure::repository::settings_repo::SettingsRepository;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub const BACKUP_ENABLED_KEY: &str = "app.config_backup_enabled";
pub const BACKUP_INTERVAL_KEY: &str = "app.config_backup_interval_min";
pub const BACKUP_DIR_KEY: &str = "app.config_backup_dir";
pub const BACKUP_ON_EXIT_KEY: &str = "app.config_backup_on_exit";
pub const BACKUP_LAST_EXPORT_KEY: &str = "app.config_backup_last_export_ms";

static EXIT_BACKUP_ATTEMPTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, Deserialize)]
struct ConfigExport {
    format: u32,
    exported_at: String,
    reason: String,
    settings: HashMap<String, String>,
}

fn setting(settings: &HashMap<String, String>, key: &str, default: &str) -> String {
    settings
        .get(key)
        .cloned()
        .unwrap_or_else(|| default.to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn safe_reason(reason: &str) -> String {
    let normalized: String = reason
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    if normalized.is_empty() {
        "manual".to_string()
    } else {
        normalized
    }
}

fn configured_settings(app: &AppHandle) -> AppResult<HashMap<String, String>> {
    let db = app.state::<DbState>();
    db.settings_repo.get_all().map_err(AppError::from)
}

pub fn export_config_to_dir(app: &AppHandle, directory: &Path, reason: &str) -> AppResult<String> {
    if directory.as_os_str().is_empty() {
        return Err(AppError::Validation("请先选择配置导出文件夹".to_string()));
    }
    std::fs::create_dir_all(directory).map_err(AppError::from)?;

    let settings = configured_settings(app)?;
    let snapshot = ConfigExport {
        format: 1,
        exported_at: Utc::now().to_rfc3339(),
        reason: safe_reason(reason),
        settings,
    };
    let bytes = serde_json::to_vec_pretty(&snapshot)
        .map_err(|error| AppError::Internal(format!("配置序列化失败: {}", error)))?;

    let filename = format!(
        "tiez-config-{}-{}.json",
        Utc::now().format("%Y%m%d-%H%M%S"),
        snapshot.reason
    );
    let destination = directory.join(filename);
    let temporary = destination.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(AppError::from)?;
    std::fs::rename(&temporary, &destination).map_err(AppError::from)?;

    let db = app.state::<DbState>();
    let _ = db
        .settings_repo
        .set(BACKUP_LAST_EXPORT_KEY, &now_ms().to_string());

    Ok(destination.to_string_lossy().to_string())
}

fn configured_directory(settings: &HashMap<String, String>) -> AppResult<PathBuf> {
    let raw = setting(settings, BACKUP_DIR_KEY, "");
    let path = PathBuf::from(raw.trim());
    if path.as_os_str().is_empty() {
        return Err(AppError::Validation("请先选择配置导出文件夹".to_string()));
    }
    Ok(path)
}

#[tauri::command]
pub fn export_config_now(app: AppHandle) -> AppResult<String> {
    let settings = configured_settings(&app)?;
    let directory = configured_directory(&settings)?;
    export_config_to_dir(&app, &directory, "manual")
}

#[tauri::command]
pub fn import_config(app: AppHandle, file_path: String) -> AppResult<u32> {
    let path = PathBuf::from(file_path.trim());
    if !path.is_file() {
        return Err(AppError::Validation("配置文件不存在".to_string()));
    }
    let raw = std::fs::read_to_string(path).map_err(AppError::from)?;
    let snapshot: ConfigExport = serde_json::from_str(&raw)
        .map_err(|error| AppError::Validation(format!("配置文件格式无效: {}", error)))?;
    if snapshot.format != 1 {
        return Err(AppError::Validation("不支持的配置文件版本".to_string()));
    }

    let db = app.state::<DbState>();
    let mut imported = 0u32;
    for (key, value) in snapshot.settings {
        if key.trim().is_empty() || key == BACKUP_LAST_EXPORT_KEY {
            continue;
        }
        db.settings_repo.set(&key, &value).map_err(AppError::from)?;
        imported += 1;
    }
    Ok(imported)
}

pub fn start_scheduler(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        let Some(db) = app.try_state::<DbState>() else {
            continue;
        };
        let Ok(settings) = db.settings_repo.get_all() else {
            continue;
        };
        if setting(&settings, BACKUP_ENABLED_KEY, "false") != "true" {
            continue;
        }
        let Ok(directory) = configured_directory(&settings) else {
            continue;
        };
        let interval_min = setting(&settings, BACKUP_INTERVAL_KEY, "60")
            .parse::<i64>()
            .unwrap_or(60)
            .clamp(1, 10080);
        let last = setting(&settings, BACKUP_LAST_EXPORT_KEY, "0")
            .parse::<i64>()
            .unwrap_or(0);
        if now_ms().saturating_sub(last) < interval_min.saturating_mul(60_000) {
            continue;
        }
        let _ = export_config_to_dir(&app, &directory, "scheduled");
    });
}

pub fn backup_on_exit(app: &AppHandle) {
    if EXIT_BACKUP_ATTEMPTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(settings) = configured_settings(app) else {
        return;
    };
    if setting(&settings, BACKUP_ON_EXIT_KEY, "true") != "true" {
        return;
    }
    let Ok(directory) = configured_directory(&settings) else {
        return;
    };
    let _ = export_config_to_dir(app, &directory, "shutdown");
}
