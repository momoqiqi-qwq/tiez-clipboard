use base64::Engine;

/// Decrypted-value cache.
///
/// `CryptUnprotectData` costs ~275us per call on this machine (measured), and a single
/// history page decrypts ~1.7 fields per row — a 60-row page is ~28ms and the old
/// limit-256 quick-paste fetch was ~120ms of pure DPAPI work **while the shared sqlite
/// connection mutex was held**. Most rows in this database are `dpapi:` encrypted, and the
/// same rows get re-fetched on every clipboard change / keystroke, so caching is a large win.
///
/// Safety of caching: decryption is a pure function of the ciphertext (no entropy, no
/// timestamp), so a cached plaintext is always identical to a fresh decryption. Re-encrypting
/// a value produces a *new* random ciphertext, i.e. a new cache key, so stale entries can
/// never be served for changed data. Entries are bounded by both count and total bytes.
#[cfg(windows)]
mod decrypted_cache {
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Mutex, OnceLock};

    const MAX_ENTRIES: usize = 4096;
    const MAX_BYTES: usize = 8 * 1024 * 1024;
    /// Never cache a single value larger than this (huge html blobs would evict everything).
    const MAX_ENTRY_BYTES: usize = MAX_BYTES / 8;

    #[derive(Default)]
    struct Cache {
        map: HashMap<String, String>,
        order: VecDeque<String>,
        bytes: usize,
    }

    impl Cache {
        fn get(&self, key: &str) -> Option<String> {
            self.map.get(key).cloned()
        }

        /// FIFO eviction. Encryption/decryption locality is strongly temporal (the same page
        /// and the same top-of-list rows are re-read constantly), so FIFO behaves like LRU here.
        fn put(&mut self, key: String, plain: String) {
            let cost = key.len() + plain.len();
            if cost > MAX_ENTRY_BYTES {
                return;
            }
            if let Some(old) = self.map.insert(key.clone(), plain) {
                self.bytes = self.bytes.saturating_sub(key.len() + old.len());
            } else {
                self.order.push_back(key);
            }
            self.bytes += cost;
            while (self.bytes > MAX_BYTES || self.map.len() > MAX_ENTRIES)
                && !self.order.is_empty()
            {
                if let Some(k) = self.order.pop_front() {
                    if let Some(v) = self.map.remove(&k) {
                        self.bytes = self.bytes.saturating_sub(k.len() + v.len());
                    }
                }
            }
        }
    }

    fn cache() -> &'static Mutex<Cache> {
        static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
        CACHE.get_or_init(|| Mutex::new(Cache::default()))
    }

    pub fn lookup(cipher: &str) -> Option<String> {
        cache().lock().ok().and_then(|c| c.get(cipher))
    }

    pub fn store(cipher: &str, plain: &str) {
        if let Ok(mut c) = cache().lock() {
            c.put(cipher.to_string(), plain.to_string());
        }
    }
}

#[cfg(windows)]
use std::ffi::c_void;

#[cfg(windows)]
type BOOL = i32;
#[cfg(windows)]
type DWORD = u32;

#[cfg(windows)]
#[repr(C)]
#[allow(non_snake_case)]
struct DATA_BLOB {
    cbData: DWORD,
    pbData: *mut u8,
}

#[cfg(windows)]
const CRYPTPROTECT_UI_FORBIDDEN: DWORD = 0x1;

#[cfg(windows)]
#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        p_data_in: *mut DATA_BLOB,
        sz_data_descr: *const u16,
        p_optional_entropy: *mut DATA_BLOB,
        pv_reserved: *mut c_void,
        p_prompt_struct: *mut c_void,
        dw_flags: DWORD,
        p_data_out: *mut DATA_BLOB,
    ) -> BOOL;

    fn CryptUnprotectData(
        p_data_in: *mut DATA_BLOB,
        ppsz_data_descr: *mut *mut u16,
        p_optional_entropy: *mut DATA_BLOB,
        pv_reserved: *mut c_void,
        p_prompt_struct: *mut c_void,
        dw_flags: DWORD,
        p_data_out: *mut DATA_BLOB,
    ) -> BOOL;
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(hmem: *mut c_void) -> *mut c_void;
}

pub const ENCRYPT_PREFIX: &str = "dpapi:";

#[cfg(windows)]
pub fn encrypt_value(plain: &str) -> Option<String> {
    let bytes = plain.as_bytes();
    let mut in_blob = DATA_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut out_blob = DATA_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &mut in_blob,
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok != 0 {
        let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) };
        let encoded = base64::engine::general_purpose::STANDARD.encode(out);
        unsafe {
            let _ = LocalFree(out_blob.pbData as _);
        }
        Some(format!("{}{}", ENCRYPT_PREFIX, encoded))
    } else {
        None
    }
}

#[cfg(windows)]
pub fn decrypt_value(cipher: &str) -> Option<String> {
    cipher.strip_prefix(ENCRYPT_PREFIX)?;
    if let Some(cached) = decrypted_cache::lookup(cipher) {
        return Some(cached);
    }
    let plain = decrypt_value_uncached(cipher)?;
    decrypted_cache::store(cipher, &plain);
    Some(plain)
}

#[cfg(windows)]
fn decrypt_value_uncached(cipher: &str) -> Option<String> {
    let payload = cipher.strip_prefix(ENCRYPT_PREFIX)?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    let mut in_blob = DATA_BLOB {
        cbData: decoded.len() as u32,
        pbData: decoded.as_ptr() as *mut u8,
    };
    let mut out_blob = DATA_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &mut in_blob,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok != 0 {
        let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) };
        let result = String::from_utf8(out.to_vec()).ok();
        unsafe {
            let _ = LocalFree(out_blob.pbData as _);
        }
        result
    } else {
        None
    }
}

#[cfg(not(windows))]
pub fn encrypt_value(plain: &str) -> Option<String> {
    Some(plain.to_string())
}

#[cfg(not(windows))]
pub fn decrypt_value(cipher: &str) -> Option<String> {
    Some(cipher.to_string())
}
