use chrono::{DateTime, Utc};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, Once};
use std::time::SystemTime;

static LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);
static PANIC_HOOK: Once = Once::new();

pub fn init(path: PathBuf) {
    {
        let mut guard = LOG_PATH.lock().unwrap_or_else(|err| err.into_inner());
        *guard = Some(path.clone());
    }

    // Release builds have no console and use panic=abort. Persist the location
    // before termination, without recording a payload that may contain clipboard
    // text, credentials, or database values. Do not acquire LOG_PATH here: a panic
    // can originate while the normal logger owns that mutex.
    PANIC_HOOK.call_once(|| {
        std::panic::set_hook(Box::new(move |panic_info| {
            let thread = std::thread::current();
            let location = panic_info
                .location()
                .map(|location| {
                    format!(
                        "{}:{}:{}",
                        location.file(),
                        location.line(),
                        location.column()
                    )
                })
                .unwrap_or_else(|| "unknown".to_string());
            let message = format!(
                "[PANIC] thread={:?} location={} (payload omitted)",
                thread.name().unwrap_or("unnamed"),
                location
            );
            append_record(&path, &message);
            let _ = writeln!(std::io::stderr().lock(), "{}", message);
        }));
    });
}

fn append_record(path: &std::path::Path, msg: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let now: DateTime<Utc> = SystemTime::now().into();
        let timestamp = now.format("%Y-%m-%d %H:%M:%S%.3f");
        let _ = writeln!(file, "[{}] {}", timestamp, msg);
    }
}

pub fn log(msg: &str) {
    if let Ok(guard) = LOG_PATH.lock() {
        if let Some(path) = &*guard {
            append_record(path, msg);
        }
    }
    // Logging must not terminate the app when a development console/pipe closes.
    let _ = writeln!(std::io::stdout().lock(), "{}", msg);
}

#[macro_export]
macro_rules! info {
    ($($arg:tt)*) => {
        $crate::logger::log(&format!($($arg)*))
    };
}

#[macro_export]
macro_rules! error {
    ($($arg:tt)*) => {
        $crate::logger::log(&format!("[ERROR] {}", format!($($arg)*)))
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_panic_without_payload_or_logger_lock() {
        const PROBE_PATH: &str = "TIEZ_LOGGER_PANIC_PROBE_PATH";
        const PRIVATE_PAYLOAD: &str = "clipboard-private-panic-payload-7d27";

        if let Some(path) = std::env::var_os(PROBE_PATH) {
            init(PathBuf::from(path));
            let _guard = LOG_PATH.lock().unwrap();
            panic!("{}", PRIVATE_PAYLOAD);
        }

        // A separate process exercises the real hook while preserving the test
        // runner's hook and globals. The panic deliberately holds LOG_PATH.
        let path = std::env::temp_dir().join(format!(
            "tiez-logger-panic-{}-{}.log",
            std::process::id(),
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "logger::tests::records_panic_without_payload_or_logger_lock",
                "--nocapture",
            ])
            .env(PROBE_PATH, &path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&path);
                panic!("panic logging deadlocked while LOG_PATH was held");
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let output = child.wait_with_output().unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(path);

        assert!(!output.status.success());
        assert!(contents.contains("[PANIC] thread="));
        assert!(contents.contains("logger.rs:"));
        assert!(!contents.contains(PRIVATE_PAYLOAD));
        assert!(!String::from_utf8_lossy(&output.stdout).contains(PRIVATE_PAYLOAD));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(PRIVATE_PAYLOAD));
    }
}
