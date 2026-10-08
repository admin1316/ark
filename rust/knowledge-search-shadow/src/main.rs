use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Read, Write};

const K1: f64 = 1.5;
const B: f64 = 0.75;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_PAGES: usize = 4096;
const MAX_QUERIES: usize = 64;
const MAX_ALIASES: usize = 64;
const MAX_PAGE_BYTES: usize = 128 * 1024;
const MAX_PATH_BYTES: usize = 1024;
const MAX_QUERY_BYTES: usize = 8192;
const MAX_QUERY_TOKENS: usize = 256;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    #[serde(rename = "requestId")]
    request_id: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    generation: u64,
    capability: String,
    #[serde(rename = "deadlineMs")]
    deadline_ms: u64,
    budget: u64,
    #[serde(rename = "cancellationToken")]
    cancellation_token: String,
    pages: Vec<Page>,
    queries: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    path: String,
    title: String,
    aliases: Vec<String>,
    text: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct Hit {
    path: String,
    score: f64,
}

#[derive(Debug, Serialize)]
struct Output {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    results: Vec<Vec<Hit>>,
    digest: String,
    #[serde(rename = "inputDigest")]
    input_digest: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Preserve lowercase mappings that can enter the TS tokenizer's ranges.
/// Other Unicode case mappings remain delimiters, including contextual sigma.
fn token_lowercase(text: &str) -> Vec<char> {
    let mut chars = Vec::with_capacity(text.len());
    for character in text.chars() {
        match character {
            'A'..='Z' => chars.push(character.to_ascii_lowercase()),
            '\u{0130}' => chars.extend(['i', '\u{0307}']),
            '\u{212a}' => chars.push('k'),
            _ => chars.push(character),
        }
    }
    chars
}

/// Emit every ASCII match first, then CJK unigrams/bigrams in source order.
fn tokenize(text: &str) -> Vec<String> {
    let chars = token_lowercase(text);
    let mut out = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index].is_ascii_alphanumeric() {
            let start = index;
            index += 1;
            while index < chars.len()
                && (chars[index].is_ascii_alphanumeric() || matches!(chars[index], '.' | '_' | '-'))
            {
                index += 1;
            }
            if index - start >= 2 {
                out.push(chars[start..index].iter().collect());
            }
            continue;
        }
        index += 1;
    }
    index = 0;
    while index < chars.len() {
        if ('\u{4e00}'..='\u{9fff}').contains(&chars[index]) {
            let start = index;
            index += 1;
            while index < chars.len() && ('\u{4e00}'..='\u{9fff}').contains(&chars[index]) {
                index += 1;
            }
            let segment = &chars[start..index];
            if segment.len() == 1 {
                out.push(segment.iter().collect());
            } else {
                for character in segment {
                    out.push(character.to_string());
                }
                for pair in segment.windows(2) {
                    out.push(pair.iter().collect());
                }
            }
            continue;
        }
        index += 1;
    }
    out
}

fn stop_words() -> HashSet<&'static str> {
    // Keep this set aligned with the stable English/Chinese stop words used by
    // knowledge-wiki/search.ts. The shadow receives no model or runtime state.
    [
        "the",
        "and",
        "or",
        "for",
        "with",
        "not",
        "all",
        "one",
        "can",
        "will",
        "when",
        "what",
        "your",
        "our",
        "you",
        "this",
        "that",
        "are",
        "was",
        "have",
        "has",
        "had",
        "from",
        "into",
        "about",
        "which",
        "would",
        "could",
        "should",
        "there",
        "their",
        "they",
        "them",
        "then",
        "than",
        "just",
        "but",
        "use",
        "used",
        "using",
        "make",
        "made",
        "get",
        "got",
        "like",
        "want",
        "need",
        "please",
        "help",
        "how",
        "why",
        "where",
        "who",
        "also",
        "very",
        "more",
        "most",
        "some",
        "any",
        "each",
        "only",
        "other",
        "such",
        "well",
        "back",
        "down",
        "over",
        "under",
        "again",
        "still",
        "even",
        "ever",
        "never",
        "now",
        "here",
        "let",
        "new",
        "old",
        "own",
        "same",
        "too",
        "way",
        "thing",
        "things",
        "something",
        "anything",
        "everything",
        "nothing",
        "someone",
        "anyone",
        "everyone",
        "sure",
        "right",
        "good",
        "bad",
        "great",
        "really",
        "actually",
        "maybe",
        "yes",
        "no",
        "ok",
        "okay",
        "hi",
        "hello",
        "知识",
        "文档",
        "文件",
        "这个",
        "什么",
        "怎么",
        "一个",
        "可以",
        "需要",
        "进行",
        "使用",
        "现在",
        "我们",
        "项目",
        "工作",
        "所有",
        "内容",
        "这样",
        "那个",
        "不是",
        "没有",
        "如果",
        "因为",
        "所以",
        "但是",
        "然后",
        "继续",
        "开始",
        "完成",
        "请问",
        "相关",
        "目前",
        "一下",
        "还有",
        "应该",
        "已经",
        "问题",
        "东西",
        "方面",
        "以及",
        "或者",
        "就是",
        "还是",
        "时候",
        "之后",
        "之前",
        "里面",
        "上面",
        "下面",
        "一些",
        "很多",
        "全部",
        "部分",
        "主要",
        "重要",
        "不同",
        "一样",
        "比较",
        "非常",
        "特别",
        "直接",
        "其实",
        "不过",
        "而且",
        "并且",
        "虽然",
        "由于",
        "因此",
        "同时",
        "另外",
        "此外",
        "其他",
        "其它",
        "通过",
        "根据",
        "按照",
        "对于",
        "关于",
        "包括",
        "包含",
        "属于",
        "来自",
        "作为",
        "成为",
        "变成",
        "产生",
        "出现",
        "存在",
        "提供",
        "支持",
        "帮助",
        "处理",
        "解决",
        "实现",
        "设计",
        "开发",
        "利用",
        "采用",
        "选择",
        "考虑",
        "要求",
        "希望",
        "想要",
        "能够",
        "可能",
        "必须",
        "一定",
        "结果",
        "效果",
        "影响",
        "情况",
        "状态",
        "方式",
        "方法",
        "过程",
        "阶段",
        "信息",
        "数据",
        "系统",
        "功能",
        "原因",
        "结论",
        "建议",
        "意见",
        "看法",
        "感觉",
        "知道",
        "看到",
        "听到",
        "想到",
        "觉得",
        "认为",
        "说明",
        "表示",
        "显示",
        "告诉",
        "询问",
        "回答",
        "回复",
    ]
    .into_iter()
    .collect()
}

fn validate_input(input: &Input) -> Result<(), String> {
    if input.schema_version != 1 {
        return Err(format!(
            "unsupported schemaVersion {}",
            input.schema_version
        ));
    }
    if input.pages.len() > MAX_PAGES {
        return Err(format!("pages exceeds limit {MAX_PAGES}"));
    }
    if input.request_id.is_empty() || input.request_id.len() > 256 {
        return Err("requestId is empty or too long".into());
    }
    if input.session_id.is_empty() || input.session_id.len() > 256 {
        return Err("sessionId is empty or too long".into());
    }
    if input.capability != "knowledge-search" {
        return Err("capability is unsupported".into());
    }
    if input.generation == 0
        || input.deadline_ms == 0
        || input.budget == 0
        || input.cancellation_token.is_empty()
    {
        return Err("deadline, budget, and cancellationToken are required".into());
    }
    if input.queries.len() > MAX_QUERIES {
        return Err(format!("queries exceeds limit {MAX_QUERIES}"));
    }
    for (page_index, page) in input.pages.iter().enumerate() {
        if page.path.is_empty() || page.path.len() > MAX_PATH_BYTES {
            return Err(format!(
                "pages[{page_index}].path exceeds limit or is empty"
            ));
        }
        if page.title.len() > MAX_PAGE_BYTES || page.text.len() > MAX_PAGE_BYTES {
            return Err(format!("pages[{page_index}] title/text exceeds limit"));
        }
        if page.aliases.len() > MAX_ALIASES
            || page
                .aliases
                .iter()
                .any(|alias| alias.len() > MAX_PAGE_BYTES)
        {
            return Err(format!("pages[{page_index}].aliases exceeds limit"));
        }
    }
    for (query_index, query) in input.queries.iter().enumerate() {
        if query.len() > MAX_QUERY_BYTES {
            return Err(format!(
                "queries[{query_index}] exceeds limit {MAX_QUERY_BYTES}"
            ));
        }
        if tokenize(query).len() > MAX_QUERY_TOKENS {
            return Err(format!(
                "queries[{query_index}] token count exceeds limit {MAX_QUERY_TOKENS}"
            ));
        }
    }
    Ok(())
}

struct Document {
    page: Page,
    tokens: Vec<String>,
    title_tokens: HashSet<String>,
    frequencies: HashMap<String, usize>,
}

fn bm25(pages: Vec<Page>, query: &str) -> Vec<Hit> {
    let documents: Vec<Document> = pages
        .into_iter()
        .map(|page| {
            let combined = format!("{}\n{}\n{}", page.title, page.aliases.join("\n"), page.text);
            let tokens = tokenize(&combined);
            let title_text = format!("{}\n{}", page.title, page.aliases.join("\n"));
            let title_tokens = tokenize(&title_text).into_iter().collect();
            let mut frequencies = HashMap::new();
            for token in &tokens {
                *frequencies.entry(token.clone()).or_insert(0) += 1;
            }
            Document {
                page,
                tokens,
                title_tokens,
                frequencies,
            }
        })
        .collect();
    let mut doc_frequency = HashMap::new();
    for document in &documents {
        let mut seen = HashSet::new();
        for token in &document.tokens {
            if seen.insert(token) {
                *doc_frequency.entry(token.clone()).or_insert(0usize) += 1;
            }
        }
    }
    let total_documents = documents.len();
    let token_count: usize = documents.iter().map(|document| document.tokens.len()).sum();
    let average_length = token_count as f64 / total_documents.max(1) as f64;
    let stop = stop_words();
    let query_tokens: Vec<String> = tokenize(query)
        .into_iter()
        .filter(|token| !stop.contains(token.as_str()))
        .collect();
    if query_tokens.is_empty() {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for document in documents {
        if document.tokens.is_empty() {
            continue;
        }
        let mut score = 0.0;
        for query_token in &query_tokens {
            let Some(&df) = doc_frequency.get(query_token) else {
                continue;
            };
            let idf = (1.0 + (total_documents as f64 - df as f64 + 0.5) / (df as f64 + 0.5)).ln();
            let tf = document.frequencies.get(query_token).copied().unwrap_or(0) as f64;
            let norm = (tf * (K1 + 1.0))
                / (tf + K1 * (1.0 - B + B * (document.tokens.len() as f64 / average_length)));
            score += idf * norm;
        }
        for query_token in &query_tokens {
            if document.title_tokens.contains(query_token) {
                score *= 1.5;
            }
        }
        if score > 0.0 {
            hits.push(Hit {
                path: document.page.path,
                score,
            });
        }
    }
    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits
}

fn process_request(input_bytes: &[u8]) -> Result<String, Box<dyn std::error::Error>> {
    if input_bytes.len() > MAX_REQUEST_BYTES {
        return Err(format!("request exceeds limit {MAX_REQUEST_BYTES} bytes").into());
    }
    let input: Input = serde_json::from_slice(&input_bytes)?;
    validate_input(&input).map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let results: Vec<Vec<Hit>> = input
        .queries
        .iter()
        .map(|query| bm25(input.pages.clone(), query))
        .collect();
    let result_bytes = serde_json::to_vec(&results)?;
    let output = Output {
        schema_version: 1,
        results,
        digest: sha256_hex(&result_bytes),
        input_digest: sha256_hex(&input_bytes),
    };
    Ok(serde_json::to_string(&output)?)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|argument| argument == "--persistent") {
        // The production candidate sends one request and closes stdin. This
        // opt-in newline-delimited mode is only for a benchmark warm envelope:
        // each line is still an independent, bounded request and response.
        let stdin = io::stdin();
        let mut stdout = io::BufWriter::new(io::stdout().lock());
        for line in stdin.lock().lines() {
            let line = line?;
            let output = process_request(line.trim_end_matches('\r').as_bytes())?;
            writeln!(stdout, "{output}")?;
            stdout.flush()?;
        }
        return Ok(());
    }

    let mut input_bytes = Vec::new();
    io::stdin()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut input_bytes)?;
    let output = process_request(&input_bytes)?;
    println!("{output}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenization_matches_ascii_and_cjk_contract() {
        assert_eq!(
            tokenize("Alpha_2 中文词"),
            vec!["alpha_2", "中", "文", "词", "中文", "文词"]
        );
        assert_eq!(tokenize("A2中文B3"), vec!["a2", "b3", "中", "文", "中文"]);
        assert_eq!(tokenize("KK"), vec!["kk"]);
        assert!(tokenize("İX").is_empty());
    }

    #[test]
    fn bm25_is_stably_sorted() {
        let pages = vec![
            Page {
                path: "a".into(),
                title: "Alpha".into(),
                aliases: vec![],
                text: "runtime".into(),
            },
            Page {
                path: "b".into(),
                title: "Beta".into(),
                aliases: vec![],
                text: "runtime".into(),
            },
        ];
        let hits = bm25(pages, "runtime");
        assert_eq!(
            hits.iter().map(|hit| hit.path.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }

    #[test]
    fn stop_words_and_input_limits_are_fail_closed() {
        let pages = vec![Page {
            path: "a".into(),
            title: "Help".into(),
            aliases: vec![],
            text: "help".into(),
        }];
        assert!(bm25(pages, "help").is_empty());
        let input = Input {
            schema_version: 1,
            request_id: "test-request".into(),
            session_id: "test-session".into(),
            generation: 1,
            capability: "knowledge-search".into(),
            deadline_ms: 30_000,
            budget: 1,
            cancellation_token: "test-cancel".into(),
            pages: vec![Page {
                path: "a".into(),
                title: String::new(),
                aliases: vec![],
                text: String::new(),
            }],
            queries: vec![],
        };
        assert!(validate_input(&input).is_ok());
        let oversized = Input {
            pages: (0..=MAX_PAGES)
                .map(|index| Page {
                    path: format!("{index}"),
                    title: String::new(),
                    aliases: vec![],
                    text: String::new(),
                })
                .collect(),
            ..input.clone()
        };
        assert!(validate_input(&oversized).is_err());
        let oversized_query = Input {
            pages: vec![],
            queries: vec!["aa ".repeat(MAX_QUERY_TOKENS + 1)],
            ..input
        };
        assert!(validate_input(&oversized_query).is_err());
        let unknown: Result<Input, _> = serde_json::from_str(
            r#"{"schemaVersion":1,"pages":[],"queries":[],"unexpected":true}"#,
        );
        assert!(unknown.is_err());
    }
}
