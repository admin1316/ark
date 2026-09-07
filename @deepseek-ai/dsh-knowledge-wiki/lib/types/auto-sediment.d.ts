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
export declare function sedimentTarget(cwd: string | undefined, mainRoot: string): {
    wikiRoot: string;
    workspaceName: string;
} | null;
/** 从会话事件列表提取：某一轮的用户输入 + 助手最终回复。 */
export interface TurnPair {
    sessionId: string;
    turn: number;
    input: string;
    output: string;
    tools: string[];
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
export declare function extractTurnPair(events: unknown[], sessionId: string, turn: number): TurnPair | null;
/**
 * 从输入中提炼一个简洁标题。
 * @param input - The input input.
 * @param sessionTitle - The session title input.
 * @returns The value produced by title from.
 */
export declare function titleFrom(input: string, sessionTitle: string | undefined): string;
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
export declare function classifyKind(input: string, output: string): 'concept' | 'problem-solving';
/**
 * 生成概念页 Markdown（frontmatter 完整六字段 + 来源标记）。kind 决定 tags 与目录。
 * @param title - The title input.
 * @param pair - The pair input.
 * @param today - The today input.
 * @param workspaceName - The workspace name input.
 * @param kind - The kind input.
 * @returns The value produced by build page.
 */
export declare function buildPage(title: string, pair: TurnPair, today: string, workspaceName: string, kind?: 'concept' | 'problem-solving'): string;
/**
 * 候选页面相对路径（kind 分流：问题解决/ 或 会话沉淀/）。
 * @param kind - The kind input.
 * @param slug - The slug input.
 * @returns The value produced by page rel path.
 */
export declare function pageRelPath(kind: 'concept' | 'problem-solving', slug: string): string;
/**
 * 稳定 slug：标题 + 会话短 id + turn，保证幂等且可读。
 * @param title - The title input.
 * @param sessionId - The session id input.
 * @param turn - The turn input.
 * @returns The value produced by slug from.
 */
export declare function slugFrom(title: string, sessionId: string, turn: number): string;
/**
 * Remove the common session- prefix before taking the stable short id.
 * @param sessionId - The session id input.
 * @returns The value produced by session short id.
 */
export declare function sessionShortId(sessionId: string): string;
/** LLM 语义分类 prompt：判定一轮对话是否「针对一个具体问题的解决」。 */
export declare const KIND_CLASSIFY_PROMPT = "\u4F60\u662F\u77E5\u8BC6\u5E93\u5206\u7C7B\u5668\u3002\u5224\u65AD\u4E0B\u9762\u8FD9\u8F6E\u5BF9\u8BDD\u662F\u5426\u300C\u9488\u5BF9\u4E00\u4E2A\u5177\u4F53\u95EE\u9898\u7684\u89E3\u51B3\u300D\uFF1A\n- problem-solving\uFF1A\u7528\u6237\u63D0\u51FA\u5177\u4F53\u95EE\u9898\uFF08\u6545\u969C\u3001\u62A5\u9519\u3001\u5916\u89C2\u7F3A\u9677\u3001\u7591\u95EE\uFF09\uFF0C\u52A9\u624B\u7ED9\u51FA\u8BCA\u65AD\u4E0E\u89E3\u51B3\uFF08\u4FEE\u590D\u3001\u8C03\u6574\u3001\u9A8C\u8BC1\u3001\u660E\u786E\u7B54\u6848\uFF09\n- concept\uFF1A\u5176\u4F59\uFF08\u901A\u7528\u77E5\u8BC6\u95EE\u7B54\u3001\u8BF4\u660E\u3001\u95F2\u804A\uFF09\n\u53EA\u8F93\u51FA JSON\uFF08\u4E0D\u8981\u5176\u4ED6\u6587\u5B57\uFF09\uFF1A{\"kind\": \"problem-solving\" \u6216 \"concept\", \"title\": \"\u4E0D\u8D85\u8FC720\u5B57\u7684\u77ED\u8BED\u6807\u9898\uFF08\u975E\u95EE\u53E5\uFF09\"}\n\n\u793A\u4F8B\uFF08problem-solving\uFF09\uFF1A\u7528\u6237\u300C\u7EBF\u592A\u7C97\u4E86 1.8x\u5C31\u597D\u300D\uFF0C\u52A9\u624B\u300C\u5DF2\u628A\u7126\u70B9\u7EBF\u52A0\u7C97\u4ECE 3x \u8C03\u56DE 1.8x\uFF0C\u5168\u90E8\u5B8C\u6210\u300D\u2014\u2014\u5916\u89C2\u7F3A\u9677 + \u8C03\u6574\u89E3\u51B3\n\u793A\u4F8B\uFF08problem-solving\uFF09\uFF1A\u7528\u6237\u300C\u8FD8\u6709\u4E00\u4E2A\u95EE\u9898 \u70B9\u5230\u65F6\u5019\u53BB\u70B9\u5176\u4ED6\u53C8\u4E0D\u663E\u793A\u989C\u8272\u662F\u7070\u8272 \u6211\u9700\u8981\u6709\u663E\u793A\u300D\uFF0C\u52A9\u624B\u7ED9\u51FA\u6839\u56E0\u4E0E\u4FEE\u590D\u2014\u2014\u53E3\u8BED\u7F3A\u9677\u62B1\u6028\uFF0C\u65E0\u95EE\u53F7\u4E5F\u7B97\n\u793A\u4F8B\uFF08concept\uFF09\uFF1A\u7528\u6237\u300C\u6709\u54EA\u4E9B\u597D\u7528\u7684\u56FE\u6807\u5E93\u300D\uFF0C\u52A9\u624B\u63A8\u8350 lucide \u7B49\u2014\u2014\u901A\u7528\u77E5\u8BC6\u95EE\u7B54\n\n\u7528\u6237\uFF1A";
/**
 * LLM 判定轮次类型 + 提炼标题（语义理解，不依赖词表）。
 *
 * @param complete - 单次 LLM 文本补全（由调用方注入，超时/失败以 reject 表达）。
 * @param input - 用户输入。
 * @param output - 助手回复。
 * @returns kind 与 title；LLM 输出不可解析或字段缺失时为 null（调用方降级启发式）。
 */
export declare function classifyWithLlm(complete: (prompt: string) => Promise<string>, input: string, output: string): Promise<{
    kind: 'concept' | 'problem-solving';
    title: string | null;
} | null>;
/**
 * 自动沉淀入口：写当前工作区一页。返回写入路径或 null（已存在）。
 * opts.kind 为 LLM 判定结果（优先级高）；缺省时退回启发式 classifyKind。
 * @param opts - The opts input.
 * @returns The value produced by sediment page.
 */
export declare function sedimentPage(opts: {
    wikiRoot: string;
    pair: TurnPair;
    sessionTitle?: string;
    today: string;
    workspaceName: string;
    kind?: 'concept' | 'problem-solving';
    title?: string;
}): string | null;
/**
 * 已存在则跳过（幂等辅助，供调用方判断）。
 * @param wikiRoot - The wiki root input.
 * @param rel - The rel input.
 * @returns The value produced by page exists.
 */
export declare function pageExists(wikiRoot: string, rel: string): boolean;
/**
 * 读取页面（供测试/校验）。
 * @param wikiRoot - The wiki root input.
 * @param rel - The rel input.
 * @returns The value produced by read page content.
 */
export declare function readPageContent(wikiRoot: string, rel: string): string;
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
export declare function extractConversationText(events: unknown[]): string;
/**
 * 会话提炼候选页的相对路径（与逐轮候选分目录）。
 * @param slug - The slug input.
 * @returns The value produced by session summary rel path.
 */
export declare function sessionSummaryRelPath(slug: string): string;
/**
 * 会话提炼页 slug：标题 + 会话短 id（无轮次——每会话只提炼一页）。
 * @param title - The title input.
 * @param sessionId - The session id input.
 * @returns The value produced by session summary slug.
 */
export declare function sessionSummarySlug(title: string, sessionId: string): string;
/**
 * 生成会话提炼页 Markdown（frontmatter + LLM 提炼正文）。
 * @param opts - The opts input.
 * @returns The value produced by build session summary page.
 */
export declare function buildSessionSummaryPage(opts: {
    title: string;
    summary: string;
    related: string[];
    sessionId: string;
    today: string;
    workspaceName: string;
    candidateKind?: 'knowledge' | 'reflection' | 'incident';
    epistemicStatus?: 'hypothesis' | 'verified' | 'disputed';
    evidenceCount?: number;
    independentSourceCount?: number;
    resolutionStatus?: 'open' | 'verified';
    issueId?: string;
}): string;
//# sourceMappingURL=auto-sediment.d.ts.map