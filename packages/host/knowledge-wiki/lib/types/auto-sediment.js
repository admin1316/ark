/**
 * 对话自动沉淀（Auto-Sediment）
 *
 * 监听 `agent/turn-stopping`：每轮对话即将收尾时，把该轮的用户输入与
 * 助手最终回复提炼为候选页，写入 **当前工作区** 的 wiki/_candidates/。
 * 这样每个工作区的知识图谱会随对话自然增长，成为该工作区的独立子图谱；
 * 万相织鉴总库通过 workspace-to-master.mjs 定期汇总各工作区精华。
 *
 * 幂等：同一会话同一 turn 只写一次（页面前言记录 sessionId + turn）。
 * 去噪：空回复、纯工具轮、超短回复（<40 字）跳过。
 * 分流：LLM 语义判定（classifyWithLlm）优先，把"针对一个具体问题"的反思
 * 沉淀到 _candidates/turns/问题解决/（kind: problem-solving），其余进
 * _candidates/turns/会话沉淀/；候选页不进入主图谱，等待治理审批。
 * LLM 失败/超时（30s）时降级到本地启发式 classifyKind（零成本兜底，仅保底不追求完备）。
 *
 * @module @deepseek-ai/dsh-knowledge-wiki/auto-sediment
 */
import { join, dirname, basename } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { z } from 'zod';
import { atomicWriteFile, readRegularFileBounded } from "./filesystem.js";
/** 每轮对话沉淀为一页的最小正文长度（字符）。 */
const MIN_BODY = 40;
/**
 * 沉淀目标：由会话所属工作区（header.cwd）决定写哪个 wiki。
 *
 * 主工作区（cwd === mainRoot 或其子路径）不实时沉淀——主库会话全部走
 * 批量摄取（raw/sources → ingest），避免重复，也防止子图谱目录
 * （如 `<mainRoot>/deepseek-harness/wiki`）混进主库文件树。
 * 其余工作区写入 `<cwd>/wiki`，形成该工作区的独立子图谱，再由
 * workspace-to-master.mjs 汇总进总库。
 *
 * @param cwd - 会话所属工作区的真实路径（SessionHeader.cwd）。
 * @param mainRoot - 主工作区根（批量摄取覆盖，实时沉淀跳过；子路径同）。
 * @returns 目标 wiki 根与工作区名；主工作区或无 cwd 时为 null（跳过）。
 */
export function sedimentTarget(cwd, mainRoot) {
    if (!cwd)
        return null;
    if (cwd === mainRoot || cwd.startsWith(mainRoot + '/'))
        return null;
    return { wikiRoot: join(cwd, 'wiki'), workspaceName: basename(cwd) };
}
/** 页面标题最大长度。 */
const MAX_TITLE = 40;
/** 正文截断长度（防止单轮超长对话撑爆页面）。 */
const MAX_BODY = 4000;
/**
 * 从事件记录中提取可读文本块（只取纯文本块，reasoning/tool-call 块跳过）。
 *
 * 输入可以是三种形态：字符串、内容块数组（`data.content` 的直接值）、
 * 或含 `content`/`text` 属性的对象（`data.message` 等）。
 */
function textOf(value) {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value)) {
        return value
            .map((block) => {
            if (typeof block === 'string')
                return block;
            if (typeof block !== 'object' || block === null || Array.isArray(block))
                return '';
            const record = block;
            if (typeof record.text === 'string' && (record.type === undefined || record.type === 'text')) {
                return record.text;
            }
            return '';
        })
            .filter(Boolean)
            .join('\n');
    }
    if (value && typeof value === 'object') {
        const record = value;
        if (typeof record.text === 'string')
            return record.text;
        if (Array.isArray(record.content))
            return textOf(record.content);
    }
    return '';
}
/** Return a boundary field only when it is already plain text. */
function stringValue(value) {
    return typeof value === 'string' ? value : '';
}
/** Collapse exact and cumulative message snapshots while preserving real deltas. */
function dedupeMessageParts(parts) {
    const out = [];
    for (const raw of parts) {
        const part = raw.trim();
        if (out.includes(part))
            continue;
        const prefixIndex = out.findIndex(existing => part.startsWith(existing));
        if (prefixIndex >= 0) {
            out[prefixIndex] = part;
            continue;
        }
        if (out.some(existing => existing.startsWith(part)))
            continue;
        out.push(part);
    }
    return out;
}
/**
 * 从会话事件列表提取指定轮的用户输入 + 助手回复。
 *
 * 事件 schema（Ark 会话日志还原后的逻辑事件）：
 * - 轮次边界由 `turn/start` 事件标记（第 k 个 turn/start 开启第 k 轮）；
 *   `user/message` 自身不带轮次，必须按边界划段归属。
 * - 文本在 `data.content[]`（用户）与 `data.message.content[]`（助手），
 *   不在顶层。
 * - 工具名在 `tool/call` 的 `data.name`。
 *
 * @param events - 会话事件记录（按 seq 升序）。
 * @param sessionId - 会话 id（原样回填到 TurnPair）。
 * @param turn - 要提取的轮次（从 1 开始，对应第 k 个 turn/start）。
 * @returns 该轮的用户输入与助手最终回复；该轮无内容或回复过短时为 null。
 */
export function extractTurnPair(events, sessionId, turn) {
    const userParts = [];
    const outputParts = [];
    const tools = [];
    let currentTurn = 0;
    for (const ev of events) {
        if (!ev || typeof ev !== 'object')
            continue;
        const e = ev;
        const type = stringValue(e.type);
        if (type === 'turn/start') {
            currentTurn++;
            continue;
        }
        if (currentTurn !== turn)
            continue;
        const data = (e.data && typeof e.data === 'object' ? e.data : {});
        if (type === 'user/message') {
            const t = textOf(data.content);
            if (t.trim())
                userParts.push(t.trim());
        }
        else if (type === 'assistant/message') {
            const message = (data.message && typeof data.message === 'object' ? data.message : {});
            const t = textOf(message.content ?? data.content);
            if (t.trim())
                outputParts.push(t.trim());
        }
        else if (type === 'tool/call') {
            const name = stringValue(data.name) || stringValue(data.tool);
            if (name)
                tools.push(name);
        }
    }
    const input = dedupeMessageParts(userParts).join('\n').trim().slice(0, 1500);
    const output = dedupeMessageParts(outputParts).join('\n').trim().slice(0, MAX_BODY);
    if (!input || !output || output.length < MIN_BODY)
        return null;
    return { sessionId, turn, input, output, tools: [...new Set(tools)].slice(0, 12) };
}
/**
 * 从输入中提炼一个简洁标题。
 * @param input - The input input.
 * @param sessionTitle - The session title input.
 * @returns The value produced by title from.
 */
export function titleFrom(input, sessionTitle) {
    const firstLine = input.split('\n').find(line => line.trim().length >= 6);
    const candidate = (firstLine ?? input).trim().replace(/[\\/:*?"<>|\s]+/gu, ' ').slice(0, MAX_TITLE);
    if (candidate.length >= 6)
        return candidate;
    return (sessionTitle?.trim() || '会话知识沉淀').slice(0, MAX_TITLE);
}
/** 输入为提问的标记（疑问词/问号，含中英文）。无 g 标志：test() 有状态会跨调用污染 lastIndex。 */
const QUESTION_SIGNS = /[？?]|吗|呢|怎么|如何|为什么|为何|能否|能不能|是不是|可否|可不可以|对不对|怎么样|哪里|哪儿|哪些|哪个/u;
/** 输入描述问题（故障词汇 / 缺陷抱怨，无问号时也命中）。「问题」单独立词：口语里「有一个问题」不会粘在「有」后。 */
const PROBLEM_SIGNS = /修复|解决|根因|排查|故障|报错|错误|原因|导致|验证|确认|坑|异常|失败|回退|回滚|变回|恢复|生效|失效|重启|定位|原因在于|没反应|打不开|显示空白|不生效/u;
/** 缺陷抱怨词（口语化，与上拆行避免 max-len）。 */
const DEFECT_SIGNS = /太[^，。\s！!]{0,4}|不对|错了|问题|不正常|奇怪|卡住|不见了|没有颜色|不显示|显示不出/u;
/** 回复给出解决动作（调整/完成/修好），与输入信号一起判定问题解决型。 */
const FIX_SIGNS = /调回|改回|改好|调好|搞定|已完成|已修|调整|改成|换成|退回|恢复|已恢复|已更新|重新|打包|部署/u;
/**
 * 确定性判定一轮对话的沉淀类型：
 * - problem-solving：输入是提问/描述问题（故障、缺陷抱怨），且回复给出
 *   问题处理与解决动作（修复/根因/排查/验证/调回/已完成…）——
 *   「针对一个具体问题的反思」，沉淀为问题解决档案；
 * - concept：其余（通用知识问答、说明、闲聊），沉淀为普通概念页。
 *
 * 零 LLM 成本；两侧信号都要求，避免把一般知识问答误判为问题解决。
 * @param input - The input input.
 * @param output - The output input.
 * @returns The value produced by classify kind.
 */
export function classifyKind(input, output) {
    const inSignal = QUESTION_SIGNS.test(input) || PROBLEM_SIGNS.test(input) || DEFECT_SIGNS.test(input);
    const outSignal = PROBLEM_SIGNS.test(output) || DEFECT_SIGNS.test(output) || FIX_SIGNS.test(output);
    return inSignal && outSignal ? 'problem-solving' : 'concept';
}
/**
 * 转义对话文本中的 wikilink 语法：对话里出现的 `[[xxx]]` 是会话内容，
 * 不是知识库链接语义——原样写入会制造指向不存在的页面的断链。
 */
function escapeWikilinks(text) {
    return text.replace(/\[\[/gu, '[').replace(/\]\]/gu, ']');
}
/**
 * 生成概念页 Markdown（frontmatter 完整六字段 + 来源标记）。kind 决定 tags 与目录。
 * @param title - The title input.
 * @param pair - The pair input.
 * @param today - The today input.
 * @param workspaceName - The workspace name input.
 * @param kind - The kind input.
 * @returns The value produced by build page.
 */
export function buildPage(title, pair, today, workspaceName, kind = 'concept') {
    const safeTitle = title.replace(/\n/gu, ' ').trim();
    const isProblem = kind === 'problem-solving';
    const frontmatter = [
        '---',
        'type: concept',
        'status: candidate',
        'origin: turn',
        `candidate_id: ${workspaceName}:${pair.sessionId}:turn-${pair.turn}`,
        `title: ${safeTitle}`,
        `tags: [${isProblem ? '问题解决' : '会话沉淀'}, 自动生成]`,
        'related: []',
        `kind: ${kind}`,
        `created: ${today}`,
        `updated: ${today}`,
        `sources: ["workspace:${workspaceName}", "session:${pair.sessionId}"]`,
        '---',
        '',
    ].join('\n');
    const body = [
        `# ${safeTitle}`,
        '',
        isProblem
            ? '> 本页由「对话自动沉淀」在轮次收尾时生成：针对一个具体问题的解决记录。'
            : '> 本页由「对话自动沉淀」在轮次收尾时生成，记录本轮对话的核心结论。',
        '',
        '## 本轮输入',
        '',
        escapeWikilinks(pair.input.slice(0, 1000)),
        '',
        '## 本轮结论',
        '',
        escapeWikilinks(pair.output.slice(0, 2000)),
        '',
        pair.tools.length > 0 ? `## 使用工具\n\n${pair.tools.map(t => `- \`${t}\``).join('\n')}\n` : '',
    ].join('\n');
    return frontmatter + body + '\n';
}
/**
 * 候选页面相对路径（kind 分流：问题解决/ 或 会话沉淀/）。
 * @param kind - The kind input.
 * @param slug - The slug input.
 * @returns The value produced by page rel path.
 */
export function pageRelPath(kind, slug) {
    return join('_candidates', 'turns', kind === 'problem-solving' ? '问题解决' : '会话沉淀', `${slug}.md`);
}
/**
 * 稳定 slug：标题 + 会话短 id + turn，保证幂等且可读。
 * @param title - The title input.
 * @param sessionId - The session id input.
 * @param turn - The turn input.
 * @returns The value produced by slug from.
 */
export function slugFrom(title, sessionId, turn) {
    const base = title.replace(/[\\/:*?"<>|\s]+/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '').slice(0, 30);
    const sid = sessionShortId(sessionId);
    return `${base}-${sid}-t${turn}`;
}
/**
 * Remove the common session- prefix before taking the stable short id.
 * @param sessionId - The session id input.
 * @returns The value produced by session short id.
 */
export function sessionShortId(sessionId) {
    const normalized = sessionId.replace(/^session-/u, '');
    return normalized.slice(0, 8) || 'unknown';
}
/** LLM 语义分类 prompt：判定一轮对话是否「针对一个具体问题的解决」。 */
export const KIND_CLASSIFY_PROMPT = `你是知识库分类器。判断下面这轮对话是否「针对一个具体问题的解决」：
- problem-solving：用户提出具体问题（故障、报错、外观缺陷、疑问），助手给出诊断与解决（修复、调整、验证、明确答案）
- concept：其余（通用知识问答、说明、闲聊）
只输出 JSON（不要其他文字）：{"kind": "problem-solving" 或 "concept", "title": "不超过20字的短语标题（非问句）"}

示例（problem-solving）：用户「线太粗了 1.8x就好」，助手「已把焦点线加粗从 3x 调回 1.8x，全部完成」——外观缺陷 + 调整解决
示例（problem-solving）：用户「还有一个问题 点到时候去点其他又不显示颜色是灰色 我需要有显示」，助手给出根因与修复——口语缺陷抱怨，无问号也算
示例（concept）：用户「有哪些好用的图标库」，助手推荐 lucide 等——通用知识问答

用户：`;
/**
 * LLM 判定轮次类型 + 提炼标题（语义理解，不依赖词表）。
 *
 * @param complete - 单次 LLM 文本补全（由调用方注入，超时/失败以 reject 表达）。
 * @param input - 用户输入。
 * @param output - 助手回复。
 * @returns kind 与 title；LLM 输出不可解析或字段缺失时为 null（调用方降级启发式）。
 */
export async function classifyWithLlm(complete, input, output) {
    const text = await complete(KIND_CLASSIFY_PROMPT + `${input.slice(0, 500)}\n助手：${output.slice(0, 1500)}`);
    const m = text.match(/\{[\s\S]*\}/u);
    if (!m)
        return null;
    let decoded;
    try {
        decoded = JSON.parse(m[0]);
    }
    catch {
        return null;
    }
    const parsed = z.object({
        kind: z.enum(['concept', 'problem-solving']),
        title: z.unknown().optional(),
    }).safeParse(decoded);
    if (!parsed.success)
        return null;
    const { kind } = parsed.data;
    const title = typeof parsed.data.title === 'string' ? parsed.data.title.trim() : '';
    return { kind, title: title || null };
}
/**
 * 自动沉淀入口：写当前工作区一页。返回写入路径或 null（已存在）。
 * opts.kind 为 LLM 判定结果（优先级高）；缺省时退回启发式 classifyKind。
 * @param opts - The opts input.
 * @returns The value produced by sediment page.
 */
export function sedimentPage(opts) {
    const { wikiRoot, pair, sessionTitle, today, workspaceName } = opts;
    const title = opts.title ?? titleFrom(pair.input, sessionTitle);
    const kind = opts.kind ?? classifyKind(pair.input, pair.output);
    const slug = slugFrom(title, pair.sessionId, pair.turn);
    const rel = pageRelPath(kind, slug);
    const full = join(wikiRoot, rel);
    if (existsSync(full))
        return null;
    const content = buildPage(title, pair, today, workspaceName, kind);
    mkdirSync(dirname(full), { recursive: true });
    atomicWriteFile(full, content);
    return rel;
}
/**
 * 已存在则跳过（幂等辅助，供调用方判断）。
 * @param wikiRoot - The wiki root input.
 * @param rel - The rel input.
 * @returns The value produced by page exists.
 */
export function pageExists(wikiRoot, rel) {
    return existsSync(join(wikiRoot, rel));
}
/**
 * 读取页面（供测试/校验）。
 * @param wikiRoot - The wiki root input.
 * @param rel - The rel input.
 * @returns The value produced by read page content.
 */
export function readPageContent(wikiRoot, rel) {
    return readRegularFileBounded(join(wikiRoot, rel), 5 * 1024 * 1024).toString('utf8');
}
/**
 * 提取会话全部对话文本（按轮组织，供 LLM 提炼）。
 *
 * 与 extractTurnPair 同源 schema：turn/start 划段，user/assistant 文本取
 * data.content[] / data.message.content[]。输出形如：
 *   第 1 轮
 *   用户：…
 *   助手：…
 *   第 2 轮 …
 * @param events - The events input.
 * @returns The value produced by extract conversation text.
 */
export function extractConversationText(events) {
    const parts = [];
    let currentTurn = 0;
    let turnParts = [];
    const flush = () => {
        if (turnParts.length > 0)
            parts.push(`第 ${currentTurn} 轮\n${turnParts.join('\n')}`);
        turnParts = [];
    };
    for (const ev of events) {
        if (!ev || typeof ev !== 'object')
            continue;
        const e = ev;
        const type = stringValue(e.type);
        if (type === 'turn/start') {
            flush();
            currentTurn++;
            continue;
        }
        if (currentTurn === 0)
            continue;
        const data = (e.data && typeof e.data === 'object' ? e.data : {});
        if (type === 'user/message') {
            const t = textOf(data.content).trim();
            if (t)
                turnParts.push(`用户：${t.slice(0, 800)}`);
        }
        else if (type === 'assistant/message') {
            const message = (data.message && typeof data.message === 'object' ? data.message : {});
            const t = textOf(message.content ?? data.content).trim();
            if (t)
                turnParts.push(`助手：${t.slice(0, 1500)}`);
        }
    }
    flush();
    return dedupeMessageParts(parts).join('\n\n').slice(0, 24000);
}
/**
 * 会话提炼候选页的相对路径（与逐轮候选分目录）。
 * @param slug - The slug input.
 * @returns The value produced by session summary rel path.
 */
export function sessionSummaryRelPath(slug) {
    return join('_candidates', 'sessions', `${slug}.md`);
}
/**
 * 会话提炼页 slug：标题 + 会话短 id（无轮次——每会话只提炼一页）。
 * @param title - The title input.
 * @param sessionId - The session id input.
 * @returns The value produced by session summary slug.
 */
export function sessionSummarySlug(title, sessionId) {
    const base = title.replace(/[\\/:*?"<>|\s]+/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '').slice(0, 30);
    return `${base}-${sessionShortId(sessionId)}`;
}
/**
 * 生成会话提炼页 Markdown（frontmatter + LLM 提炼正文）。
 * @param opts - The opts input.
 * @returns The value produced by build session summary page.
 */
export function buildSessionSummaryPage(opts) {
    const { title, summary, related, sessionId, today, workspaceName, candidateKind = 'knowledge', epistemicStatus = 'hypothesis', evidenceCount = 1, independentSourceCount = 1, resolutionStatus, issueId, } = opts;
    const safeTitle = title.replace(/\n/gu, ' ').trim().slice(0, 40);
    const relatedList = related.length > 0 ? `[${related.map(r => `"${r.replace(/"/gu, '')}"`).join(', ')}]` : '[]';
    const frontmatter = [
        '---',
        'type: concept',
        'status: candidate',
        'origin: session',
        `candidate_id: ${workspaceName}:${sessionId}:session`,
        `candidate_kind: ${candidateKind}`,
        `epistemic_status: ${epistemicStatus}`,
        `evidence_count: ${Math.max(1, evidenceCount)}`,
        `independent_source_count: ${Math.max(1, independentSourceCount)}`,
        ...(resolutionStatus ? [`resolution_status: ${resolutionStatus}`] : []),
        ...(issueId ? [`issue_id: ${issueId}`] : []),
        `title: ${safeTitle}`,
        'tags: [会话提炼, 自动生成]',
        `related: ${relatedList}`,
        `created: ${today}`,
        `updated: ${today}`,
        `sources: ["workspace:${workspaceName}", "session:${sessionId}"]`,
        '---',
        '',
    ].join('\n');
    const body = [
        `# ${safeTitle}`,
        '',
        '> 本页由「会话 AI 提炼」在会话结束时生成：把整段对话浓缩为可复用知识。',
        '',
        escapeWikilinks(summary.trim().slice(0, 6000)),
        '',
    ].join('\n');
    return frontmatter + body + '\n';
}
//# sourceMappingURL=auto-sediment.js.map