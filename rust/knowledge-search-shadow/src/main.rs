use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, BufWriter, Read, Write};
use std::sync::LazyLock;

const K1: f64 = 1.5;
const B: f64 = 0.75;
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_SERVER_REQUESTS: usize = 512;
const MAX_SERVER_TOTAL_BYTES: usize = 256 * 1024 * 1024;
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

struct SearchJsonFormatter;

impl serde_json::ser::Formatter for SearchJsonFormatter {
    fn write_f64<W: Write + ?Sized>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
        let mut buffer = ryu_js::Buffer::new();
        writer.write_all(buffer.format_finite(value).as_bytes())
    }
}

fn serialize_search_json(value: &impl Serialize) -> Result<Vec<u8>, serde_json::Error> {
    let mut bytes = Vec::new();
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, SearchJsonFormatter);
    value.serialize(&mut serializer)?;
    Ok(bytes)
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

static STOP_WORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(stop_words);

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
    token_count: usize,
    title_tokens: HashSet<String>,
    frequencies: HashMap<String, usize>,
}

struct SearchIndex {
    documents: Vec<Document>,
    doc_frequency: HashMap<String, usize>,
    average_length: f64,
}

fn prepare_index(pages: Vec<Page>) -> SearchIndex {
    let documents: Vec<Document> = pages
        .into_iter()
        .map(|page| {
            let combined = format!("{}\n{}\n{}", page.title, page.aliases.join("\n"), page.text);
            let tokens = tokenize(&combined);
            let token_count = tokens.len();
            let title_text = format!("{}\n{}", page.title, page.aliases.join("\n"));
            let title_tokens = tokenize(&title_text).into_iter().collect();
            let mut frequencies = HashMap::new();
            for token in tokens {
                *frequencies.entry(token).or_insert(0) += 1;
            }
            Document {
                page,
                token_count,
                title_tokens,
                frequencies,
            }
        })
        .collect();
    let mut doc_frequency = HashMap::new();
    for document in &documents {
        for token in document.frequencies.keys() {
            *doc_frequency.entry(token.clone()).or_insert(0usize) += 1;
        }
    }
    let token_count: usize = documents.iter().map(|document| document.token_count).sum();
    let average_length = token_count as f64 / documents.len().max(1) as f64;
    SearchIndex {
        documents,
        doc_frequency,
        average_length,
    }
}

fn bm25(index: &SearchIndex, query: &str) -> Vec<Hit> {
    let query_tokens: Vec<String> = tokenize(query)
        .into_iter()
        .filter(|token| !STOP_WORDS.contains(token.as_str()))
        .collect();
    if query_tokens.is_empty() {
        return Vec::new();
    }
    let total_documents = index.documents.len();
    let mut hits = Vec::new();
    for document in &index.documents {
        if document.token_count == 0 {
            continue;
        }
        let mut score = 0.0;
        for query_token in &query_tokens {
            let Some(&df) = index.doc_frequency.get(query_token) else {
                continue;
            };
            let idf = (1.0 + (total_documents as f64 - df as f64 + 0.5) / (df as f64 + 0.5)).ln();
            let tf = document.frequencies.get(query_token).copied().unwrap_or(0) as f64;
            let norm = (tf * (K1 + 1.0))
                / (tf + K1 * (1.0 - B + B * (document.token_count as f64 / index.average_length)));
            score += idf * norm;
        }
        for query_token in &query_tokens {
            if document.title_tokens.contains(query_token) {
                score *= 1.5;
            }
        }
        if score > 0.0 {
            hits.push(Hit {
                path: document.page.path.clone(),
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

fn process_request(input_bytes: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if input_bytes.len() > MAX_REQUEST_BYTES {
        return Err(format!("request exceeds limit {MAX_REQUEST_BYTES} bytes").into());
    }
    let input: Input = serde_json::from_slice(input_bytes)?;
    validate_input(&input).map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let index = prepare_index(input.pages);
    let results: Vec<Vec<Hit>> = input
        .queries
        .iter()
        .map(|query| bm25(&index, query))
        .collect();
    let result_bytes = serialize_search_json(&results)?;
    let output = Output {
        schema_version: 1,
        results,
        digest: sha256_hex(&result_bytes),
        input_digest: sha256_hex(input_bytes),
    };
    let output_bytes = serialize_search_json(&output)?;
    if output_bytes.len() > MAX_RESPONSE_BYTES {
        return Err(format!("response exceeds limit {MAX_RESPONSE_BYTES} bytes").into());
    }
    Ok(output_bytes)
}

fn read_bounded_line<R: BufRead>(reader: &mut R, line: &mut Vec<u8>) -> io::Result<bool> {
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(!line.is_empty());
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if line
            .len()
            .checked_add(consumed)
            .is_none_or(|length| length > MAX_REQUEST_BYTES + 2)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("request line exceeds limit {MAX_REQUEST_BYTES} bytes"),
            ));
        }
        let complete = available.get(consumed - 1) == Some(&b'\n');
        line.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if complete {
            return Ok(true);
        }
    }
}

fn serve<R: BufRead, W: Write>(
    mut reader: R,
    mut writer: W,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut line = Vec::new();
    let mut request_count = 0;
    let mut total_bytes = 0usize;
    loop {
        line.clear();
        if !read_bounded_line(&mut reader, &mut line)? {
            break;
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.len() > MAX_REQUEST_BYTES {
            return Err(format!("request exceeds limit {MAX_REQUEST_BYTES} bytes").into());
        }
        if request_count >= MAX_SERVER_REQUESTS {
            return Err(format!("server request count exceeds limit {MAX_SERVER_REQUESTS}").into());
        }
        total_bytes = total_bytes.checked_add(line.len()).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "server byte count overflow")
        })?;
        if total_bytes > MAX_SERVER_TOTAL_BYTES {
            return Err(
                format!("server input exceeds limit {MAX_SERVER_TOTAL_BYTES} bytes").into(),
            );
        }
        let response = process_request(&line)?;
        writer.write_all(&response)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        request_count += 1;
    }
    Ok(())
}

fn run_single() -> Result<(), Box<dyn std::error::Error>> {
    let mut input_bytes = Vec::new();
    io::stdin()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut input_bytes)?;
    let output = process_request(&input_bytes)?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(&output)?;
    stdout.write_all(b"\n")?;
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        None => run_single(),
        Some("--serve") if args.next().is_none() => {
            let stdin = io::stdin();
            let stdout = io::stdout();
            serve(BufReader::new(stdin.lock()), BufWriter::new(stdout.lock()))
        }
        _ => Err("usage: knowledge-search-shadow [--serve]".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_serialization_matches_ecmascript_number_boundaries() {
        let cases = [
            (-0.0, "0"),
            (1.0, "1"),
            (1e-7, "1e-7"),
            (1e-6, "0.000001"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.6708623161681031e19, "16708623161681031000"),
            (0.30000000000000004, "0.30000000000000004"),
            (f64::MAX, "1.7976931348623157e+308"),
            (f64::from_bits(1), "5e-324"),
        ];
        for (score, expected) in cases {
            assert_eq!(serialize_search_json(&score).unwrap(), expected.as_bytes());
        }
    }

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
        let index = prepare_index(pages);
        let hits = bm25(&index, "runtime");
        assert_eq!(
            hits.iter().map(|hit| hit.path.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }

    #[test]
    fn prepared_index_serves_multiple_queries_without_changing_results() {
        let index = prepare_index(vec![
            Page {
                path: "a".into(),
                title: "Runtime recovery".into(),
                aliases: vec!["cancellation".into()],
                text: "verified session replay".into(),
            },
            Page {
                path: "b".into(),
                title: "Policy".into(),
                aliases: vec![],
                text: "scope and cancellation".into(),
            },
        ]);

        assert_eq!(
            bm25(&index, "runtime")
                .iter()
                .map(|hit| hit.path.as_str())
                .collect::<Vec<_>>(),
            vec!["a"]
        );
        assert_eq!(
            bm25(&index, "cancellation")
                .iter()
                .map(|hit| hit.path.as_str())
                .collect::<Vec<_>>(),
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
        assert!(bm25(&prepare_index(pages), "help").is_empty());
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

    #[test]
    fn line_server_replays_multiple_requests_with_per_request_digests() {
        let first = br#"{"schemaVersion":1,"requestId":"r1","sessionId":"s1","generation":1,"capability":"knowledge-search","deadlineMs":1000,"budget":1,"cancellationToken":"c1","pages":[{"path":"runtime.md","title":"Runtime recovery","aliases":[],"text":"verified replay"}],"queries":["runtime"]}"#;
        let second = br#"{"schemaVersion":1,"requestId":"r2","sessionId":"s2","generation":2,"capability":"knowledge-search","deadlineMs":1000,"budget":1,"cancellationToken":"c2","pages":[{"path":"policy.md","title":"Policy","aliases":[],"text":"scope recovery"}],"queries":["scope"]}"#;
        let input = [&first[..], &second[..]]
            .into_iter()
            .flat_map(|request| request.iter().copied().chain(*b"\n"))
            .collect::<Vec<_>>();
        let mut output = Vec::new();

        serve(io::Cursor::new(input), &mut output).unwrap();

        let responses = output
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["inputDigest"], sha256_hex(first));
        assert_eq!(responses[1]["inputDigest"], sha256_hex(second));
        assert_eq!(responses[0]["results"][0][0]["path"], "runtime.md");
        assert_eq!(responses[1]["results"][0][0]["path"], "policy.md");
    }

    #[test]
    fn line_server_rejects_an_oversized_frame_before_writing_a_response() {
        let input = vec![b'x'; MAX_REQUEST_BYTES + 3];
        let mut output = Vec::new();
        assert!(serve(io::Cursor::new(input), &mut output).is_err());
        assert!(output.is_empty());
    }
}
