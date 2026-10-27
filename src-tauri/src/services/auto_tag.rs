use regex::Regex;
use std::sync::OnceLock;

/// Official auto-classification tags. Seeded into `saved_tags` and assigned
/// automatically to clipboard entries by content inspection. They are not part
/// of SENSITIVE_TAGS: they never trigger encryption, they only group entries.
pub const OFFICIAL_AUTO_TAGS: &[&str] = &["网站", "手机号", "邮箱", "apikey", "网盘"];

/// Category tags in priority order: `classify_auto_tags` assigns at most ONE
/// category tag per entry (highest priority wins), and every categorized entry
/// also carries "sensitive" — sensitive is the superset of all category tags.
const CATEGORY_PRIORITY: &[&str] = &["apikey", "手机号", "邮箱", "网盘", "网站"];

/// Composition tags, assigned only when NO category tag matched: they bucket
/// the leftovers ("未识别") by character makeup so opaque tokens — order ids,
/// hashes, invite codes — stay groupable. They never imply "sensitive": they
/// only group, they do not encrypt.
pub const COMPOSITION_TAGS: &[&str] = &["纯数字", "纯字母", "数字字母"];

const PATTERN_SCAN_MAX_BYTES: usize = 5000;

/// Longer than this is a document, not a token; bucketing prose by character
/// makeup would only add noise.
const COMPOSITION_MAX_BYTES: usize = 1000;

/// Shortest content worth bucketing — one or two characters is never a token.
const COMPOSITION_MIN_CHARS: usize = 3;

pub fn is_official_tag(name: &str) -> bool {
    name == "sensitive" || name == "密码" || is_system_tag(name)
}

/// Tags the classifier owns at runtime (category + composition), as opposed to
/// tags the user created. System tags are seeded at migration time, protected
/// from rename/delete, and dropped again when the rules stop producing them.
pub fn is_system_tag(name: &str) -> bool {
    OFFICIAL_AUTO_TAGS
        .iter()
        .chain(COMPOSITION_TAGS.iter())
        .any(|t| t.eq_ignore_ascii_case(name))
}

fn cloud_drive_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?ix)(
                pan\.baidu\.com
              | aliyundrive\.com
              | alipan\.com
              | pan\.quark\.cn
              | quark\.cn
              | 123pan\.com
              | 123684\.com
              | 123865\.com
              | 123912\.com
              | lanzou
              | lanzn\.com
              | lanpv\.com
              | lanzv\.com
              | lanpw\.com
              | weiyun\.com
              | caiyun\.139\.com
              | cloud\.189\.cn
              | 115\.com
              | 115cdn\.com
              | anxia\.com
              | pan\.xunlei\.com
              | drive\.uc\.cn
              | cowtransfer\.com
              | wenshushu\.cn
              | mega\.nz
              | mediafire\.com
              | wetransfer\.com
              | drive\.google\.com
              | 1drv\.ms
              | onedrive\.live\.com
            )",
        )
        .unwrap()
    })
}

fn phone_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Explicit non-digit boundaries instead of \b: CJK chars are Unicode
        // word chars, so \b fails between them and digits ("电话是138...").
        // Supported: 中国大陆 1[3-9]xxxxxxxxx（可带 +86 前缀）；香港/英国号码
        // 必须带 +852/852、+44/0 前缀。裸的 8 位/10 位数字串一律不识别——
        // 订单号、UUID 片段、短验证码的误报率太高。
        Regex::new(
            r"(?x)(?:\A|\D)(
                (?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}
              | (?:\+?852[-\s]?)[234569]\d{3}[-\s]?\d{4}
              | (?:\+?44[-\s]?|0)7\d{3}[-\s]?\d{3}[-\s]?\d{3}
            )(?:\z|\D)",
        )
        .unwrap()
    })
}

fn email_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}").unwrap())
}

fn api_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // ASCII-only keeps the compiled program small (\w in Unicode mode is huge).
        Regex::new(
            r#"(?ix-u)\b(?:
                (?:sk|pk|rk)-[\w\-]{20,}
              | ghp_[\w]{20,}
              | gho_[\w]{20,}
              | github_pat_[\w]{20,}
              | AIza[\w\-]{20,}
              | AKIA[\w]{16,}
              | ASIA[\w]{16,}
              | ya29\.[\w\-]{20,}
              | xox[baprs]-[\w\-]{10,}
              | glpat-[\w\-]{15,}
              | hf_[\w]{20,}
              | r8_[\w]{20,}
              | sq0atp-[\w\-]{20,}
              | sq0csp-[\w\-]{20,}
              | shpat_[\w]{20,}
              | dop_v1_[\w]{20,}
              | Bearer\s+[\w\-.]{20,}
              | (?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|token)[\s:=]+['"]?[\w\-]{16,}
            )"#,
        )
        .unwrap()
    })
}

/// Bucket a leftover token by character makeup: all ASCII digits → "纯数字",
/// all ASCII letters → "纯字母", both present → "数字字母".
///
/// Anything else (whitespace, punctuation, hyphens, CJK, symbols) returns None:
/// the point is a *pure* token, and a mixed blob is better left untagged than
/// misfiled — prose and UUIDs would otherwise flood these buckets.
fn classify_composition_tag(trimmed: &str) -> Option<&'static str> {
    if trimmed.len() > COMPOSITION_MAX_BYTES {
        return None;
    }

    let mut chars = 0usize;
    let mut digits = 0usize;
    let mut letters = 0usize;
    for ch in trimmed.chars() {
        chars += 1;
        if ch.is_ascii_digit() {
            digits += 1;
        } else if ch.is_ascii_alphabetic() {
            letters += 1;
        } else {
            return None;
        }
    }

    if chars < COMPOSITION_MIN_CHARS {
        return None;
    }

    match (digits > 0, letters > 0) {
        (true, false) => Some("纯数字"),
        (false, true) => Some("纯字母"),
        (true, true) => Some("数字字母"),
        (false, false) => None,
    }
}

/// Inspect clipboard content and return the official tags it should carry:
/// at most one category tag (by `CATEGORY_PRIORITY`) plus "sensitive".
/// `content_type` is the entry's detected type ("url", "text", "code", ...).
///
/// When no category tag matches, the entry falls back to at most one
/// composition tag (see `classify_composition_tag`) — the two groups are
/// disjoint by design.
pub fn classify_auto_tags(content: &str, content_type: &str) -> Vec<String> {
    let trimmed = content.trim();
    if trimmed.is_empty() || trimmed.starts_with("data:") {
        return Vec::new();
    }

    let mut candidates: Vec<&'static str> = Vec::new();

    // "网站" is reserved for URL-typed entries that are not cloud drive shares;
    // cloud drive links take priority so the two groups stay disjoint. A cloud
    // drive link inside plain text still counts as 网盘.
    if cloud_drive_re().is_match(trimmed) {
        candidates.push("网盘");
    } else if content_type == "url" {
        candidates.push("网站");
    }

    // Pattern-based tags are too noisy on long documents; only scan short text.
    if trimmed.len() <= PATTERN_SCAN_MAX_BYTES {
        if phone_re().is_match(trimmed) {
            candidates.push("手机号");
        }
        if email_re().is_match(trimmed) {
            candidates.push("邮箱");
        }
        if api_key_re().is_match(trimmed) {
            candidates.push("apikey");
        }
    }

    let mut tags: Vec<String> = Vec::new();
    if let Some(category) = CATEGORY_PRIORITY
        .iter()
        .find(|c| candidates.iter().any(|x| x == *c))
    {
        tags.push(category.to_string());
        tags.push("sensitive".to_string());
    } else if let Some(composition) = classify_composition_tag(trimmed) {
        // Unrecognized content: group it by character makeup instead of leaving
        // it tagless. Not "sensitive" — nothing secret is implied by "纯数字".
        tags.push(composition.to_string());
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(content: &str, content_type: &str) -> Vec<String> {
        classify_auto_tags(content, content_type)
    }

    #[test]
    fn classifies_plain_url_as_website() {
        assert_eq!(
            tags("https://www.example.com/page?id=1", "url"),
            vec!["网站", "sensitive"]
        );
        assert_eq!(tags("www.example.com", "url"), vec!["网站", "sensitive"]);
    }

    #[test]
    fn classifies_cloud_drive_links() {
        assert_eq!(
            tags("https://pan.baidu.com/s/1abc?pwd=xyz", "url"),
            vec!["网盘", "sensitive"]
        );
        assert_eq!(
            tags("https://www.alipan.com/s/xyz", "url"),
            vec!["网盘", "sensitive"]
        );
        assert_eq!(
            tags("https://pan.quark.cn/s/abc123", "url"),
            vec!["网盘", "sensitive"]
        );
        // Cloud drive wins over website even inside plain text.
        assert_eq!(
            tags("链接 https://pan.baidu.com/s/1abc 提取码 abcd", "text"),
            vec!["网盘", "sensitive"]
        );
    }

    #[test]
    fn classifies_phone_numbers() {
        // 中国大陆（裸号或带 +86 前缀）
        assert_eq!(tags("19175988337", "text"), vec!["手机号", "sensitive"]);
        assert_eq!(tags("+86 158-3168-0345", "text"), vec!["手机号", "sensitive"]);
        assert_eq!(
            tags("电话是13653264630谢谢", "text"),
            vec!["手机号", "sensitive"]
        );
        // 香港：必须带 852/+852 前缀
        assert_eq!(tags("+852 6123 4567", "text"), vec!["手机号", "sensitive"]);
        assert_eq!(tags("852-21234567", "text"), vec!["手机号", "sensitive"]);
        // 英国：必须带 0 或 +44 前缀
        assert_eq!(tags("07123456789", "text"), vec!["手机号", "sensitive"]);
        assert_eq!(tags("07123 456789", "text"), vec!["手机号", "sensitive"]);
        assert_eq!(tags("+44 7123 456789", "text"), vec!["手机号", "sensitive"]);
        assert_eq!(tags("+447123456789", "text"), vec!["手机号", "sensitive"]);
    }

    #[test]
    fn rejects_phone_false_positives() {
        // Pure digit strings are NOT phones — they may still fall into the
        // "纯数字" composition bucket, so assert on the phone tag only.
        let no_phone = |content: &str| {
            let result = tags(content, "text");
            assert!(
                !result.iter().any(|t| t == "手机号"),
                "unexpected 手机号 for {:?}: {:?}",
                content,
                result
            );
            result
        };
        // 港/英裸号不再识别：8 位/10 位数字串误报率过高
        assert!(no_phone("61234567").iter().all(|t| t == "纯数字"));
        assert!(no_phone("9123-4567").is_empty());
        assert!(no_phone("7856215531").iter().all(|t| t == "纯数字"));
        assert!(no_phone("7935847389").iter().all(|t| t == "纯数字"));
        // 10 位 QQ 号、400 热线、12 位座机
        assert!(no_phone("2533450096").iter().all(|t| t == "纯数字"));
        assert!(no_phone("4001234567").iter().all(|t| t == "纯数字"));
        assert!(no_phone("075512345678").iter().all(|t| t == "纯数字"));
        // UUID 与应用协议串里的数字片段（带连字符/空格，不进纯数字桶）
        assert!(no_phone("43712110-1a06-42e0-a44c-a2d65fd9d673").is_empty());
        assert!(no_phone("ms-a0de3abd-7c70-4138-9266-1d96bf3d6781").is_empty());
        assert!(no_phone(
            "start \"\" \"quicker:runaction:43712110-1a06-42e0-a44c-a2d65fd9d673\"\"",
        )
        .is_empty());
        assert!(no_phone("61419745").iter().all(|t| t == "纯数字"));
        assert!(no_phone("95581594").iter().all(|t| t == "纯数字"));
    }

    #[test]
    fn buckets_unrecognized_tokens_by_composition() {
        // 全数字 / 全字母 / 数字字母交叉：未识别内容的三类分组
        assert_eq!(tags("61419745", "text"), vec!["纯数字"]);
        assert_eq!(tags("1024", "text"), vec!["纯数字"]);
        assert_eq!(tags("abcdef", "text"), vec!["纯字母"]);
        assert_eq!(tags("HelloWorld", "text"), vec!["纯字母"]);
        assert_eq!(tags("a1B2c3", "text"), vec!["数字字母"]);
        assert_eq!(tags("INV20261009X", "text"), vec!["数字字母"]);

        // 组合标签不带 sensitive：它们只分组，不触发加密
        assert!(!tags("a1B2c3", "text").iter().any(|t| t == "sensitive"));

        // 含空格/标点/中文/短串的都不归桶
        assert!(tags("hello world", "text").is_empty());
        assert!(tags("2026-10-09", "text").is_empty());
        assert!(tags("中文abc", "text").is_empty());
        assert!(tags("ab", "text").is_empty());
        assert!(tags("1", "text").is_empty());

        // 分类标签优先，二者互斥
        assert_eq!(
            tags("2533450096@qq.com", "text"),
            vec!["邮箱", "sensitive"]
        );
        assert_eq!(tags("19175988337", "text"), vec!["手机号", "sensitive"]);
        assert_eq!(
            tags("https://www.example.com/a1B2", "url"),
            vec!["网站", "sensitive"]
        );
    }

    #[test]
    fn classifies_emails() {
        assert_eq!(
            tags("2533450096@qq.com", "text"),
            vec!["邮箱", "sensitive"]
        );
        assert_eq!(tags("foo.bar@gmail.com", "text"), vec!["邮箱", "sensitive"]);
    }

    #[test]
    fn classifies_api_keys() {
        assert_eq!(
            tags("sk-ea688c9e635e459d94db5efdcdf89d65", "text"),
            vec!["apikey", "sensitive"]
        );
        assert_eq!(
            tags("sk-or-v1-2f39e365b340f6fa1f884e554e4cb6013d995d776cd87e85b75be8f3d3dfeca", "text"),
            vec!["apikey", "sensitive"]
        );
        assert_eq!(
            tags("ghp_0123456789abcdefghijklmnopqrstuvwxyz", "text"),
            vec!["apikey", "sensitive"]
        );
        assert_eq!(
            tags("api_key: 0123456789abcdef0123", "text"),
            vec!["apikey", "sensitive"]
        );
    }

    #[test]
    fn skips_images_and_empty_content() {
        assert!(tags("data:image/png;base64,AAAA", "image").is_empty());
        assert!(tags("   ", "text").is_empty());
    }

    #[test]
    fn at_most_one_category_tag_and_sensitive_superset() {
        // Mixed phone + email content gets exactly one category tag (priority),
        // and "sensitive" always accompanies it.
        let result = tags("联系 2533450096@qq.com 或拨打 13800138000", "text");
        assert_eq!(result, vec!["手机号", "sensitive"]);
    }

    #[test]
    fn official_tag_detection() {
        assert!(is_official_tag("网站"));
        assert!(is_official_tag("apikey"));
        assert!(is_official_tag("sensitive"));
        assert!(is_official_tag("密码"));
        // Composition tags are system-owned too
        assert!(is_official_tag("纯数字"));
        assert!(is_official_tag("纯字母"));
        assert!(is_official_tag("数字字母"));
        assert!(is_system_tag("纯数字"));
        assert!(!is_system_tag("sensitive"));
        assert!(!is_official_tag("cd"));
    }
}
