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

/// Shape tags describe *what kind of text* the entry is, independent of the
/// category/composition buckets above: a long document and an AI prompt are
/// identified here so they can be filtered ("tag:长文本") instead of hunted for
/// by keyword. Like composition tags they only group — they never imply
/// "sensitive" and never trigger encryption.
pub const SHAPE_TAGS: &[&str] = &["长文本", "AI提示词"];

/// Content at least this many characters (CJK characters, not bytes) counts as
/// 长文本. Ordinary clipboard text — a sentence, a token, a path — stays far
/// below; a paragraph or two already crosses it.
pub const LONG_TEXT_MIN_CHARS: usize = 200;

/// Shortest content that can be an AI prompt. Below this, "请帮我..." is just
/// everyday phrasing and tagging it would bury the real prompts.
const PROMPT_MIN_CHARS: usize = 40;

/// Prompt shape (role, task, output format) is declared at the top, so only the
/// head of a long document is scanned.
const PROMPT_SCAN_MAX_CHARS: usize = 4000;
/// Upper bound for the prompt judgement. A prompt longer than this is a pasted
/// page or a document, not something someone wrote to hand to a model.
const PROMPT_MAX_CHARS: usize = 12_000;
/// A prompt opens with its ask. Answers, docs and articles also use 请/不要
/// somewhere in the body, so the imperative has to show up in the opening
/// stretch to count.
const PROMPT_OPENING_SCAN_CHARS: usize = 200;

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
        .chain(SHAPE_TAGS.iter())
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

fn prompt_self_reference_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Wording that only shows up when someone is addressing a model:
        // a role assignment, or the word "prompt" itself.
        Regex::new(
            r"(?ix)(
                提示词
              | system\s*prompt
              | prompt\s*(?:template|模板)
              | 角色扮演
              | 你的人设
              | 你是(?:一|个|位)
              | 你的(?:任务|角色|身份|目标)
              | 作为一名
              | 作为一个
              | you\s+are\s+(?:a|an|the|my|an?\s+expert)\b
              | act\s+as\s+(?:a|an|the|my)\b
            )",
        )
        .unwrap()
    })
}

fn prompt_instruction_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Imperative phrasing: what someone *asks for*, in Chinese and English.
        // Deliberately excludes 要求/规则 — those are section labels (structure),
        // and counting them twice would flag every spec document.
        Regex::new(
            r"(?ix)(
                请(?:你|帮我)?|麻烦(?:你)?|帮我|帮忙|需要你|你将|你现在
              | 扮演|模拟|假设|生成|撰写|起草|扩写|续写|润色|改写|重写|翻译
              | 写一(?:篇|份|个|段|条)|总结(?:一下)?|概括|归纳|提炼
              | 解释(?:一下)?|分析(?:一下)?|列出|列举|输出|返回|给出|整理
              | 评估|对比|检查|优化|拆解|分点|分条
              | 不要|别用|必须|务必|注意
              | \b(?:please|write|summari[sz]e|translate|rewrite|explain|list|output
                 |return|generate|analys[ei]|respond|reply|do not|don't|must|should
                 |step[- ]by[- ]step|make sure)\b
            )",
        )
        .unwrap()
    })
}

fn prompt_structure_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Layout of a prompt: markdown headings, bullet/numbered lines, and
        // labelled sections (角色：/ 任务：/ 输出格式：/ Role: / Format: ...).
        Regex::new(
            r"(?ixm)(
                ^\s*\#{1,4}\s
              | ^\s*[-*•·]\s
              | ^\s*\d{1,2}[.、)）]\s?
              | (?:角色|身份|任务|目标|背景|要求|约束|规则|输出格式|格式|示例|例子|步骤|流程|注意事项|风格|语气
                 |context|role|task|goal|requirement|instruction|constraint|format|example|rule|steps?)
                \s*[:：]
            )",
        )
        .unwrap()
    })
}

/// Share of CJK characters and whitespace: prose has one or the other, while
/// base64 blobs, hashes and minified JSON have neither.
fn prose_share(text: &str) -> (usize, usize) {
    let mut total = 0usize;
    let mut cjk = 0usize;
    let mut spaces = 0usize;
    for ch in text.chars() {
        total += 1;
        if ('\u{3400}'..='\u{9fff}').contains(&ch) || ('\u{f900}'..='\u{faff}').contains(&ch) {
            cjk += 1;
        } else if ch.is_whitespace() {
            spaces += 1;
        }
    }
    if total == 0 {
        return (0, 0);
    }
    (cjk * 100 / total, spaces * 100 / total)
}

/// Long *text*: enough characters that the entry is a document rather than a
/// one-liner, and written as prose rather than a single opaque token.
fn is_long_text(trimmed: &str, content_type: &str) -> bool {
    if !matches!(content_type, "text" | "rich_text" | "code") {
        return false;
    }
    if trimmed.chars().count() < LONG_TEXT_MIN_CHARS {
        return false;
    }
    let (cjk, spaces) = prose_share(trimmed);
    cjk >= 4 || spaces >= 8
}

/// Heuristic: does this read like a prompt written *for* a model?
///
/// Precision beats recall here — a wrong "AI提示词" on every requirements doc
/// makes the filter useless — so a single polite word is never enough: the text
/// needs a role assignment, or an ask in its opening stretch followed by several
/// imperative verbs, or imperative verbs plus the section/bullet layout that
/// prompts tend to have. Answers and docs say 请/不要 halfway down the page.
fn looks_like_ai_prompt(trimmed: &str, content_type: &str) -> bool {
    if !matches!(content_type, "text" | "rich_text") {
        return false;
    }
    let total = trimmed.chars().count();
    if !(PROMPT_MIN_CHARS..=PROMPT_MAX_CHARS).contains(&total) {
        return false;
    }
    let sample: String = trimmed.chars().take(PROMPT_SCAN_MAX_CHARS).collect();
    if prompt_self_reference_re().is_match(&sample) {
        return true;
    }
    let opening: String = sample.chars().take(PROMPT_OPENING_SCAN_CHARS).collect();
    if !prompt_instruction_re().is_match(&opening) {
        return false;
    }
    let instructions = prompt_instruction_re().find_iter(&sample).count();
    if instructions == 0 {
        return false;
    }
    let structure = prompt_structure_re().find_iter(&sample).count();
    instructions >= 4 || (instructions >= 2 && structure >= 1) || (instructions >= 1 && structure >= 2)
}

fn shape_tags(trimmed: &str, content_type: &str) -> Vec<&'static str> {
    let mut tags = Vec::new();
    if is_long_text(trimmed, content_type) {
        tags.push("长文本");
    }
    if looks_like_ai_prompt(trimmed, content_type) {
        tags.push("AI提示词");
    }
    tags
}

/// Inspect clipboard content and return the official tags it should carry:
/// at most one category tag (by `CATEGORY_PRIORITY`) plus "sensitive".
/// `content_type` is the entry's detected type ("url", "text", "code", ...).
///
/// When no category tag matches, the entry falls back to at most one
/// composition tag (see `classify_composition_tag`) — the two groups are
/// disjoint by design.
///
/// Shape tags ("长文本" / "AI提示词", see `SHAPE_TAGS`) are independent of those
/// buckets and stack on top of them.
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

    // Shape tags stack on top of the bucket above: a long document can also read
    // like a prompt, and a long document that happens to contain a phone number
    // keeps its category tag too. Still never "sensitive" by itself.
    for shape in shape_tags(trimmed, content_type) {
        if !tags.iter().any(|existing| existing == shape) {
            tags.push(shape.to_string());
        }
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
    fn tags_long_prose_as_long_text() {
        let para = "今天下午把剪贴板历史从头翻了一遍，重复的内容比预想的多得多，\n".repeat(10);
        let result = tags(&para, "text");
        assert!(result.contains(&"长文本".to_string()), "{:?}", result);
        // 只分组，不加密
        assert!(!result.iter().any(|t| t == "sensitive"));

        // 长但不是文本：base64/哈希这类密串、超长 URL 都不算长文本
        let blob = "aGVsbG8xMjM0NTY3ODkw".repeat(30);
        assert!(!tags(&blob, "text").iter().any(|t| t == "长文本"));
        let url = format!("https://example.com/{}", "a".repeat(300));
        assert!(!tags(&url, "url").iter().any(|t| t == "长文本"));

        // 不到 200 字的普通句子不进这个桶
        assert!(tags("hello world", "text").is_empty());
    }

    #[test]
    fn detects_ai_prompts() {
        // 角色设定：自指直接命中
        let role_prompt = "你是一名资深前端工程师。\n\n请审查下面的 React 组件，只指出会导致线上问题的地方。\n\n要求：\n- 按严重程度排序\n- 每条给出修改后的代码\n\n输出格式：Markdown 表格。";
        assert!(tags(role_prompt, "text").contains(&"AI提示词".to_string()));

        // 没有角色设定，但指令密集
        let task_prompt = "请帮我写一份本周的工作周报，总结本周完成的需求和进展，列出遇到的风险点，给出下周计划，语气正式一些，不要用第一人称。";
        assert!(tags(task_prompt, "text").contains(&"AI提示词".to_string()));

        // 说明文/回答式内容：指令词只出现在中后段，开头没有"请求"，不算提示词
        let filler = "这段内容用于占位，不包含任何指令。".repeat(12);
        let late_ask = format!("{}\n请帮我总结并列出要点，不要遗漏，必须给出结论。", filler);
        assert!(late_ask.chars().count() > 200);
        assert!(
            !tags(&late_ask, "text").iter().any(|t| t == "AI提示词"),
            "{:?}",
            tags(&late_ask, "text")
        );

        // 日常邮件/说明不是提示词
        let mail = "麻烦你确认一下附件里的金额是否正确，另外把上周的数据重新整理一遍，我们明天开会要用，谢谢。";
        assert!(!tags(mail, "text").iter().any(|t| t == "AI提示词"), "{:?}", tags(mail, "text"));

        let notes = "会议纪要：今天讨论了三件事，第一是排期，第二是人力，第三是上线时间。\n".repeat(4);
        assert!(!tags(&notes, "text").iter().any(|t| t == "AI提示词"));

        // 整页粘贴（论坛/文档）远超提示词长度上限，指令再密也不算
        let page_dump = "请帮我整理这段内容，列成要点，不要遗漏。\n".repeat(700);
        assert!(page_dump.chars().count() > 12_000);
        assert!(!tags(&page_dump, "text").iter().any(|t| t == "AI提示词"));

        // 代码不参与提示词判定
        let code = "请帮我写一份周报，总结本周进展，列出风险，给出下周计划，不要用第一人称。\n".repeat(3);
        assert!(tags(&code, "text").contains(&"AI提示词".to_string()));
        assert!(!tags(&code, "code").iter().any(|t| t == "AI提示词"));
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
        // Shape tags are system-owned too: seeded, protected, and re-derived
        assert!(is_official_tag("长文本"));
        assert!(is_official_tag("AI提示词"));
        assert!(is_system_tag("长文本"));
        assert!(is_system_tag("AI提示词"));
        assert!(!is_system_tag("sensitive"));
        assert!(!is_official_tag("cd"));
    }
}
