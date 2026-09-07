import Foundation
import JiuzhangShellCore

func runArkDomainAPIContractChecks() {
  let businessConflict: JSONValue = .object([
    "path": .string("concepts/example.md"),
    "ok": .bool(false),
    "conflict": .bool(true),
    "error": .string("stale"),
  ])
  let unwrappedBusinessConflict = try? ArkAPIClient.remoteValue(from: .object([
    "ok": .bool(true),
    "value": businessConflict,
  ]))
  check(
    unwrappedBusinessConflict == businessConflict
      && (try? ArkDomainAPIContract.knowledgeWrite(from: unwrappedBusinessConflict ?? .null))?.conflict == true,
    "strict Remote unwrap removes one Gateway layer without consuming a business ok/conflict result"
  )
  do {
    _ = try ArkAPIClient.remoteValue(from: .object([
      "ok": .bool(false),
      "error": .object([
        "code": .string("arguments-invalid"),
        "message": .string("bad request"),
        "details": .object(["field": .string("request")]),
      ]),
    ]))
    check(false, "strict Remote unwrap rejects a Gateway failure")
  } catch let error as ArkAPIError {
    check(
      error.code == "arguments-invalid"
        && error.details?["field"]?.stringValue == "request",
      "strict Remote unwrap preserves Gateway failure code and details"
    )
  } catch {
    check(false, "strict Remote unwrap preserves Gateway failure code and details")
  }

  let feedbackList = try? ArkFeedbackAPIContract.items(from: .object([
    "items": .array([
      .object([
        "messageId": .string("message-1"),
        "rating": .string("positive"),
        "note": .string("clear"),
        "version": .string("11111111-1111-4111-8111-111111111111"),
      ]),
    ]),
  ]))
  check(
    feedbackList?.first?.messageID == "message-1"
      && feedbackList?.first?.rating == .positive
      && feedbackList?.first?.note == "clear"
      && feedbackList?.first?.version == "11111111-1111-4111-8111-111111111111",
    "native message feedback decodes the value already unwrapped by remoteCall"
  )
  do {
    _ = try ArkFeedbackAPIContract.items(from: .object([
      "ok": .bool(true),
      "value": .object(["items": .array([])]),
    ]))
    check(false, "native message feedback rejects the obsolete double-wrapped result")
  } catch {
    check(true, "native message feedback rejects the obsolete double-wrapped result")
  }
  do {
    try ArkFeedbackAPIContract.requireDeleted(from: .object(["absent": .bool(true)]))
    check(true, "native message feedback accepts one committed delete value")
  } catch {
    check(false, "native message feedback accepts one committed delete value")
  }
  let baseURL = URL(string: "http://127.0.0.1:3080")!
  check(
    ArkAPIClient.endpointURL(
      baseURL: baseURL,
      method: ArkDomainAPIContract.Method.commandsExecute
    ).absoluteString == "http://127.0.0.1:3080/api/commands/execute",
    "native command endpoint preserves its Remote namespace"
  )
  check(
    ArkAPIClient.endpointURL(
      baseURL: baseURL,
      method: ArkDomainAPIContract.Method.knowledgeResolveReviews
    ).absoluteString == "http://127.0.0.1:3080/api/knowledgeWiki/resolveReviews",
    "native knowledge endpoint preserves its Remote namespace"
  )
  check(
    ArkAPIClient.endpointURL(
      baseURL: baseURL,
      method: ArkDomainAPIContract.Method.knowledgeWritePage
    ).absoluteString == "http://127.0.0.1:3080/api/knowledgeWiki/writePage",
    "native Wiki editing uses the Host-owned writePage endpoint"
  )
  check(
    ArkAPIClient.endpointURL(
      baseURL: baseURL,
      method: ArkDomainAPIContract.Method.knowledgeIngestQueueStatus
    ).absoluteString == "http://127.0.0.1:3080/api/knowledgeWiki/ingestQueueStatus"
      && ArkAPIClient.endpointURL(
        baseURL: baseURL,
        method: ArkDomainAPIContract.Method.knowledgeIngestQueueCancel
      ).absoluteString == "http://127.0.0.1:3080/api/knowledgeWiki/ingestQueueCancel",
    "native Wiki queue uses the existing Host Remote namespace"
  )
  let ingestQueue = try? ArkDomainAPIContract.knowledgeIngestQueue(from: .object([
    "tasks": .array([
      .object([
        "id": .number(4),
        "input": .string("https://example.com/article"),
        "status": .string("running"),
      ]),
      .object([
        "id": .number(5),
        "input": .string("notes.md"),
        "status": .string("done"),
        "written": .array([.string("_candidates/ingest/notes.md")]),
      ]),
    ]),
    "running": .bool(true),
    "cancelled": .bool(false),
  ]))
  check(
    ingestQueue?.tasks.count == 2
      && ingestQueue?.hasActiveTasks == true
      && ingestQueue?.pendingCount == 0
      && ingestQueue?.completedCount == 1
      && ingestQueue?.tasks.last?.written == ["_candidates/ingest/notes.md"],
    "native Wiki queue decodes typed task state and written paths"
  )
  check(
    (try? ArkDomainAPIContract.knowledgeIngestQueue(from: .object([
      "tasks": .array([.object([
        "id": .number(1.5),
        "input": .string("bad"),
        "status": .string("pending"),
      ])]),
      "running": .bool(false),
      "cancelled": .bool(false),
    ]))) == nil,
    "native Wiki queue fails closed on malformed task identity"
  )
  check(
    ArkKnowledgeIngestInput.normalizedHTTPURL("  https://example.com/article  ")
      == "https://example.com/article"
      && ArkKnowledgeIngestInput.normalizedHTTPURL("file:///tmp/private.md") == nil
      && ArkKnowledgeIngestInput.normalizedHTTPURL("javascript:alert(1)") == nil
      && ArkKnowledgeIngestInput.normalizedHTTPURL("https:///missing-host") == nil,
    "native Wiki URL import admits only normalized http(s) inputs with a host"
  )
  let conflictedWrite = try? ArkDomainAPIContract.knowledgeWrite(from: .object([
    "path": .string("concepts/example.md"),
    "ok": .bool(false),
    "conflict": .bool(true),
    "error": .string("page changed on disk; reload before saving"),
  ]))
  check(
    conflictedWrite?.succeeded == false
      && conflictedWrite?.conflict == true
      && conflictedWrite?.path == "concepts/example.md",
    "native Wiki editing preserves compare-and-swap conflict evidence"
  )
  check(
    ArkAPIClient.endpointURL(
      baseURL: baseURL,
      method: ArkArchiveAPIContract.Method.workspaceUnarchiveSession
    ).absoluteString == "http://127.0.0.1:3080/api/workspace/unarchiveSession",
    "native archive restore uses the strict workspace Remote endpoint"
  )
  check(
    ArkAPIClient.endpointURL(
      baseURL: baseURL,
      method: ArkArchiveAPIContract.Method.workspaceDeleteArchivedSession
    ).absoluteString == "http://127.0.0.1:3080/api/workspace/deleteArchivedSession",
    "native archived-session deletion uses the strict workspace Remote endpoint"
  )
  check(
    ArkAPIClient.endpointURL(
      baseURL: baseURL,
      method: ArkPluginSettingsAPIContract.Method.mutate
    ).absoluteString == "http://127.0.0.1:3080/api/settings/mutate",
    "native plugin settings use the strict settings Remote endpoint"
  )
  check(
    ArkAPIClient.endpointURL(
      baseURL: baseURL,
      method: ArkDomainAPIContract.Method.workbenchWebRead
    ).absoluteString == "http://127.0.0.1:3080/api/workbench/webRead",
    "native Workbench Web reader stays inside the API-only strict Remote namespace"
  )

  let workbenchWeb = try? ArkDomainAPIContract.workbenchWebDocument(from: .object([
    "url": .string("https://docs.example.test/guide"),
    "title": .string("docs.example.test"),
    "statusCode": .number(200),
    "markdown": .string("# Guide\n\nNative reader"),
    "truncated": .bool(false),
  ]))
  check(
    workbenchWeb == ArkWorkbenchWebDocument(
      url: "https://docs.example.test/guide",
      title: "docs.example.test",
      statusCode: 200,
      markdown: "# Guide\n\nNative reader",
      truncated: false
    ),
    "native Workbench decodes bounded browser-free Web reader documents"
  )

  let archiveRequest = try? ArkArchiveAPIContract.sessionRequest(sessionID: "session-archived")
  check(
    archiveRequest?["sessionId"]?.stringValue == "session-archived",
    "native archive mutations preserve the exact session id"
  )
  do {
    _ = try ArkArchiveAPIContract.sessionRequest(sessionID: "")
    check(false, "native archive mutations reject an empty session id")
  } catch {
    check(
      error.localizedDescription == "归档会话标识不能为空",
      "native archive mutations report the empty session id precisely"
    )
  }

  let restoredArchive = try? ArkArchiveAPIContract.unarchivedSessionIDs(from: .object([
    "archivedSessionIds": .array([.string("session-two"), .string("session-three")]),
  ]))
  check(
    restoredArchive == ["session-two", "session-three"],
    "native archive restore preserves the authoritative archive order"
  )
  do {
    _ = try ArkArchiveAPIContract.unarchivedSessionIDs(from: .object([
      "archivedSessionIds": .array([.string("")]),
    ]))
    check(false, "native archive restore rejects a malformed archive snapshot")
  } catch {
    check(
      error.localizedDescription == "本机服务返回了无效的 workspace/unarchiveSession 响应",
      "native archive restore reports malformed responses precisely"
    )
  }

  let remainingArchive = try? ArkArchiveAPIContract.deletedArchivedSessionIDs(from: .object([
    "deleted": .bool(true),
    "archivedSessionIds": .array([.string("session-three")]),
  ]))
  check(
    remainingArchive == ["session-three"],
    "native archived-session deletion requires the committed marker and preserves the remaining archive"
  )

  for invalidDeletion in [
    JSONValue.object(["archivedSessionIds": .array([])]),
    JSONValue.object(["deleted": .bool(false), "archivedSessionIds": .array([])]),
    JSONValue.object(["deleted": .bool(true), "archivedSessionIds": .array([.string("")])]),
  ] {
    do {
      _ = try ArkArchiveAPIContract.deletedArchivedSessionIDs(from: invalidDeletion)
      check(false, "native archived-session deletion rejects an uncommitted or malformed response")
    } catch {
      check(
        error.localizedDescription
          == "本机服务返回了无效的 workspace/deleteArchivedSession 响应",
        "native archived-session deletion reports malformed responses precisely"
      )
    }
  }

  func pluginNamespace(
    _ namespace: String,
    value: [String: JSONValue],
    user: [String: JSONValue]? = nil,
    revision: Int
  ) -> JSONValue {
    var row: [String: JSONValue] = [
      "ns": .string(namespace),
      "schema": .object(["type": .string("object")]),
      "value": .object(value),
      "applies": .string("live"),
      "secrets": .array(namespace == "web-search-deepseek" ? [
        .object([
          "path": .array([.string("apiKey")]),
          "set": .bool(true),
        ]),
      ] : []),
      "revision": .number(Double(revision)),
    ]
    if let user { row["user"] = .object(user) }
    return .object(row)
  }

  let pluginSettings = try? ArkPluginSettingsAPIContract.snapshot(from: .object([
    "writable": .bool(true),
    "hasDocument": .bool(true),
    "namespaces": .array([
      pluginNamespace(
        "shell",
        value: [
          "timeoutMs": .number(120_000),
          "maxTimeoutMs": .number(600_000),
          "maxOutputBytes": .number(64_000),
          "maxSpillBytes": .number(67_108_864),
          "graceMs": .number(3_000),
        ],
        user: ["maxOutputBytes": .number(64_000), "graceMs": .number(3_000)],
        revision: 3
      ),
      pluginNamespace(
        "agent-loop",
        value: ["maxParallelToolCalls": .number(10)],
        revision: 4
      ),
      pluginNamespace(
        "web-search-deepseek",
        value: [
          "apiKeyEnv": .string("DEEPSEEK_API_KEY"),
          "baseURL": .string("https://search.example/v1"),
          "model": .string("deepseek-v4-flash"),
          "apiVersion": .string("2023-06-01"),
          "maxTokens": .number(4_096),
          "maxUses": .number(5),
        ],
        user: [
          "baseURL": .string("https://search.example/v1"),
          "maxTokens": .number(4_096),
        ],
        revision: 5
      ),
      pluginNamespace("future-plugin", value: ["enabled": .bool(true)], revision: 1),
    ]),
  ]))
  check(pluginSettings?.writable == true, "native plugin settings preserve document writability")
  check(pluginSettings?.shell?.timeoutMs == 120_000, "native plugin settings decode shell timeout")
  check(
    pluginSettings?.shell?.maxTimeoutMs == 600_000
      && pluginSettings?.shell?.maxSpillBytes == 67_108_864
      && pluginSettings?.shell?.graceMs == 3_000,
    "native plugin settings decode every advanced shell budget"
  )
  check(
    pluginSettings?.shell?.overriddenFields == ["maxOutputBytes", "graceMs"],
    "native plugin settings preserve shell field overrides"
  )
  check(
    pluginSettings?.agentLoop?.maxParallelToolCalls == 10,
    "native plugin settings decode the agent-loop parallel cap"
  )
  check(
    pluginSettings?.webSearchDeepSeek?.credentialReference == "DEEPSEEK_API_KEY"
      && pluginSettings?.webSearchDeepSeek?.baseURL == "https://search.example/v1"
      && pluginSettings?.webSearchDeepSeek?.model == "deepseek-v4-flash"
      && pluginSettings?.webSearchDeepSeek?.apiVersion == "2023-06-01"
      && pluginSettings?.webSearchDeepSeek?.maxTokens == 4_096
      && pluginSettings?.webSearchDeepSeek?.maxUses == 5,
    "native plugin settings decode only the redacted DeepSeek search fields"
  )

  let shellSet = try? ArkPluginSettingsAPIContract.shellMutationPayload(
    edit: .setTimeoutMs(9_000),
    expectedRevision: 3
  )
  check(shellSet?["ns"]?.stringValue == "shell", "native shell edits target the shell namespace")
  check(
    shellSet?["ops"]?.arrayValue?.first?["path"]?.arrayValue?.first?.stringValue == "timeoutMs"
      && shellSet?["ops"]?.arrayValue?.first?["value"]?.numberValue == 9_000
      && shellSet?["expectedRevision"]?.numberValue == 3,
    "native shell set carries one field and the expected revision"
  )
  let shellUnset = try? ArkPluginSettingsAPIContract.shellMutationPayload(
    edit: .unsetMaxOutputBytes,
    expectedRevision: 4
  )
  check(
    shellUnset?["ops"]?.arrayValue?.first?["op"]?.stringValue == "unset"
      && shellUnset?["ops"]?.arrayValue?.first?["path"]?.arrayValue?.first?.stringValue
        == "maxOutputBytes",
    "native shell reset is a field-level unset"
  )
  let shellBatch = try? ArkPluginSettingsAPIContract.shellMutationPayload(
    edits: [
      .setTimeoutMs(15_000),
      .unsetMaxOutputBytes,
      .setGraceMs(2_000),
    ],
    expectedRevision: 9
  )
  check(
    shellBatch?["ops"]?.arrayValue?.count == 3
      && shellBatch?["ops"]?.arrayValue?[1]["op"]?.stringValue == "unset"
      && shellBatch?["expectedRevision"]?.numberValue == 9,
    "native shell batch applies several fields under one expected revision"
  )

  let agentSet = try? ArkPluginSettingsAPIContract.agentLoopMutationPayload(
    edit: .setMaxParallelToolCalls(4),
    expectedRevision: 7
  )
  check(
    agentSet?["ns"]?.stringValue == "agent-loop"
      && agentSet?["ops"]?.arrayValue?.first?["value"]?.numberValue == 4,
    "native agent-loop set preserves its positive integer"
  )

  let webReferenceSet = try? ArkPluginSettingsAPIContract.webSearchMutationPayload(
    edits: [
      .setCredentialReference("ARK_SEARCH_KEY"),
      .unsetBaseURL,
      .setModel("deepseek-search"),
      .setAPIVersion("2023-06-01"),
      .setMaxTokens(8_192),
      .setMaxUses(3),
    ],
    expectedRevision: 8
  )
  check(
    webReferenceSet?["ns"]?.stringValue == "web-search-deepseek"
      && webReferenceSet?["ops"]?.arrayValue?.first?["path"]?.arrayValue?.first?.stringValue
        == "apiKeyEnv"
      && webReferenceSet?["ops"]?.arrayValue?.first?["value"]?.stringValue == "ARK_SEARCH_KEY"
      && webReferenceSet?["ops"]?.arrayValue?.count == 6
      && webReferenceSet?["expectedRevision"]?.numberValue == 8,
    "native web-search settings batch resolved fields and only the credential reference"
  )
  let encodedWebReference = try? JSONEncoder().encode(webReferenceSet)
  check(
    encodedWebReference.flatMap { String(data: $0, encoding: .utf8) }?.contains("secret") == false,
    "native web-search mutation payload carries no secret field"
  )

  do {
    _ = try ArkPluginSettingsAPIContract.webSearchMutationPayload(
      edit: .setCredentialReference("not-a-ref"),
      expectedRevision: 1
    )
    check(false, "native web-search settings reject an invalid credential reference")
  } catch {
    check(true, "native web-search settings reject an invalid credential reference")
  }
  do {
    _ = try ArkPluginSettingsAPIContract.agentLoopMutationPayload(
      edit: .setMaxParallelToolCalls(0),
      expectedRevision: 1
    )
    check(false, "native plugin settings reject an invalid positive integer")
  } catch {
    check(true, "native plugin settings reject an invalid positive integer")
  }
  do {
    _ = try ArkPluginSettingsAPIContract.shellMutationPayload(
      edits: [.setTimeoutMs(1_000), .unsetTimeoutMs],
      expectedRevision: 1
    )
    check(false, "native plugin settings reject duplicate fields in one batch")
  } catch {
    check(true, "native plugin settings reject duplicate fields in one batch")
  }
  do {
    _ = try ArkPluginSettingsAPIContract.webSearchMutationPayload(
      edits: [],
      expectedRevision: 1
    )
    check(false, "native plugin settings reject an empty batch")
  } catch {
    check(true, "native plugin settings reject an empty batch")
  }
  do {
    _ = try ArkPluginSettingsAPIContract.snapshot(from: .object([
      "writable": .bool(true),
      "hasDocument": .bool(true),
      "namespaces": .array([
        pluginNamespace(
          "shell",
          value: [
            "timeoutMs": .number(120_000),
            "maxTimeoutMs": .number(600_000),
            "maxOutputBytes": .number(64_000),
            "maxSpillBytes": .string("not-a-number"),
            "graceMs": .number(3_000),
          ],
          revision: 1
        ),
      ]),
    ]))
    check(false, "native plugin settings reject a malformed resolved shell field")
  } catch {
    check(true, "native plugin settings reject a malformed resolved shell field")
  }
  do {
    _ = try ArkPluginSettingsAPIContract.snapshot(from: .object([
      "writable": .bool(true),
      "hasDocument": .bool(true),
      "namespaces": .array([
        pluginNamespace(
          "web-search-deepseek",
          value: [
            "apiKey": .string("must-not-cross-the-wire"),
            "apiKeyEnv": .string("DEEPSEEK_API_KEY"),
            "model": .string("deepseek-v4-flash"),
            "apiVersion": .string("2023-06-01"),
            "maxTokens": .number(4_096),
            "maxUses": .number(5),
          ],
          revision: 1
        ),
      ]),
    ]))
    check(false, "native plugin settings reject a leaked web-search secret")
  } catch {
    check(true, "native plugin settings reject a leaked web-search secret")
  }
  do {
    _ = try ArkPluginSettingsAPIContract.shellMutationResult(from: pluginNamespace(
      "agent-loop",
      value: ["maxParallelToolCalls": .number(2)],
      revision: 2
    ))
    check(false, "native plugin mutation decoders reject a substituted namespace")
  } catch {
    check(true, "native plugin mutation decoders reject a substituted namespace")
  }

  let searchPage = try? ArkDomainAPIContract.sessionSearch(from: .object([
    "items": .array([
      .object(["sessionId": .string("session-1"), "snippet": .string("匹配内容")]),
    ]),
    "hasMore": .bool(true),
  ]))
  check(
    searchPage == ArkSessionSearchPage(
      items: [ArkSessionSearchHit(sessionID: "session-1", snippet: "匹配内容")],
      hasMore: true
    ),
    "native session search parser preserves hits and continuation state"
  )

  let models = try? ArkDomainAPIContract.sessionModels(from: .object([
    "current": .object([
      "provider": .string("deepseek"),
      "model": .string("deepseek-reasoner"),
      "reasoningEffort": .string("high"),
    ]),
    "routable": .bool(true),
    "groups": .array([
      .object([
        "id": .string("deepseek"),
        "name": .string("DeepSeek"),
        "models": .array([
          .object([
            "id": .string("deepseek-reasoner"),
            "name": .string("DeepSeek Reasoner"),
            "reasoning": .object([
              "efforts": .array([
                .object(["id": .string("high"), "name": .string("High")]),
              ]),
              "defaultEffort": .string("high"),
            ]),
          ]),
        ]),
      ]),
    ]),
    "failures": .array([]),
  ]))
  check(models?.current.reasoningEffort == "high", "native model parser preserves the active effort")
  check(
    models?.groups.first?.models.first?.reasoning?.efforts.first?.id == "high",
    "native model parser preserves provider-owned effort ids"
  )

  let command = try? ArkDomainAPIContract.commandExecution(from: .object([
    "commandId": .string("command-1"),
    "result": .object([
      "kind": .string("success"),
      "text": .string("preset workspace-write"),
      "sourceEventSeq": .number(42),
    ]),
  ]))
  check(command?.result == .success, "native command parser preserves success results")
  check(command?.sourceEventSequence == 42, "native command parser preserves source event linkage")
  do {
    let unmatched = try ArkDomainAPIContract.commandExecution(from: .null)
    check(unmatched == nil, "native command parser preserves an unmatched command")
  } catch {
    check(false, "native command parser preserves an unmatched command")
  }

  let reviews = try? ArkDomainAPIContract.knowledgeReviews(from: .array([
    .object([
      "id": .string("review-1"),
      "title": .string("候选知识"),
      "type": .string("candidate"),
      "resolved": .bool(false),
      "affectedPages": .array([.string("concepts/a.md")]),
      "options": .array([
        .object(["action": .string("Promote"), "label": .string("采纳")]),
      ]),
    ]),
  ]))
  check(reviews?.first?.actions.first?.action == "Promote", "native review parser preserves Host actions")
  check(reviews?.first?.affectedPages == ["concepts/a.md"], "native review parser preserves affected pages")

  do {
    _ = try ArkDomainAPIContract.sessionSearch(from: .object([
      "items": .array([.object(["sessionId": .string("broken")])]),
      "hasMore": .bool(false),
    ]))
    check(false, "native domain parsers reject malformed required fields")
  } catch {
    check(true, "native domain parsers reject malformed required fields")
  }
}
