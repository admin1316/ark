import Foundation
import JiuzhangShellCore
import JiuzhangShellUI

/// One canonical `view` envelope as tool presentation attaches it to history
/// events: `{ for: "call"|"result", view: <presentation payload> }`.
private func toolEvent(
  _ id: Int,
  _ type: String,
  _ data: JSONValue,
  _ view: JSONValue
) -> ArkHistoryEvent {
  ArkHistoryEvent(
    id: id,
    type: type,
    time: Date(timeIntervalSince1970: Double(id)),
    data: data,
    view: .object([
      "for": .string(type == "tool/call" ? "call" : "result"),
      "view": view,
    ])
  )
}

private func durableEvent(
  _ id: Int,
  _ type: String,
  _ data: JSONValue
) -> ArkHistoryEvent {
  ArkHistoryEvent(
    id: id,
    type: type,
    time: Date(timeIntervalSince1970: Double(id)),
    data: data,
    view: nil
  )
}

private func generic(_ view: ArkToolPresentation?) -> ArkGenericPresentation? {
  if case .generic(let card) = view { return card }
  return nil
}

private func terminal(_ view: ArkToolPresentation?) -> ArkTerminalPresentation? {
  if case .terminal(let card) = view { return card }
  return nil
}

private func diff(_ view: ArkToolPresentation?) -> ArkDiffPresentation? {
  if case .diff(let card) = view { return card }
  return nil
}

private func search(_ view: ArkToolPresentation?) -> ArkSearchPresentation? {
  if case .search(let card) = view { return card }
  return nil
}

private func read(_ view: ArkToolPresentation?) -> ArkReadPresentation? {
  if case .read(let card) = view { return card }
  return nil
}

private func web(_ view: ArkToolPresentation?) -> ArkWebPresentation? {
  if case .web(let card) = view { return card }
  return nil
}

func runArkToolPresentationContractChecks() {
  let todoActivity = ArkToolActivity(
    id: "todo-call",
    sequence: 1,
    name: "todo_write",
    arguments: #"{"todos":[{"content":"Investigate","status":"completed"},{"content":"Fix","status":"in_progress"},{"content":"Verify","status":"pending"}]}"#,
    rawCall: .object([:])
  )
  let todoPresentation: ArkTodoListPresentation? = {
    guard case .todo(let list) = todoActivity.structuredView else { return nil }
    return list
  }()
  check(
    todoPresentation?.items.map(\.content) == ["Investigate", "Fix", "Verify"]
      && todoPresentation?.completedCount == 1
      && todoPresentation?.runningCount == 1
      && todoPresentation?.pendingCount == 1,
    "native tool projection decodes durable todo arguments into typed task rows and counts"
  )

  let questionActivity = ArkToolActivity(
    id: "question-call",
    sequence: 2,
    name: "ask_user_question",
    arguments: #"{"questions":[{"id":"choice","header":"Choose","question":"Continue?","options":[{"label":"Yes","description":"Proceed"},{"label":"No"}]}]}"#,
    result: "Error: the user cancelled ask_user_question",
    isError: true,
    rawCall: .object([:])
  )
  let questionPresentation: ArkQuestionBatchPresentation? = {
    guard case .questions(let batch) = questionActivity.structuredView else { return nil }
    return batch
  }()
  check(
    questionPresentation?.questions.first?.id == "choice"
      && questionPresentation?.questions.first?.header == "Choose"
      && questionPresentation?.questions.first?.question == "Continue?"
      && questionPresentation?.questions.first?.options?.map(\.label) == ["Yes", "No"],
    "native tool projection decodes ask_user_question prompts and options without parsing assistant text"
  )

  let genericCall = generic(ArkToolPresentation.decode(.object([
    "card": .string("generic"),
    "title": .string("写入 plan.md"),
    "kind": .string("edit"),
    "rawInput": .string("plan.md"),
    "locations": .array([
      .object(["path": .string("/w/plan.md"), "line": .number(12)]),
      .object(["path": .string("/w/plan.md")]),
    ]),
  ])))
  check(
    genericCall?.title == "写入 plan.md"
      && genericCall?.kind == "edit"
      && genericCall?.rawInput == "plan.md"
      && genericCall?.locations.count == 2
      && genericCall?.locations[0].path == "/w/plan.md"
      && genericCall?.locations[0].line == 12
      && genericCall?.locations[1].line == nil,
    "native tool keys decode a generic call card's title, kind, raw input, and locations"
  )

  let routedFile = ArkToolActivity(
    id: "routed-file",
    sequence: 1,
    name: "str_replace_editor",
    arguments: "",
    rawCall: .object([:]),
    callPresentation: .object([
      "card": .string("generic"),
      "title": .string("Edit old.md"),
      "locations": .array([.object(["path": .string("old.md")])]),
    ]),
    resultPresentation: .object([
      "card": .string("diff"),
      "diffs": .array([.object([
        "path": .string("Sources/New.swift"),
        "newText": .string("let ready = true"),
      ])]),
    ])
  )
  check(
    routedFile.primaryFileLocation == ArkFileLocation(path: "Sources/New.swift"),
    "native tool file routing prefers the actual result location over the requested call location"
  )

  let rawObject = generic(ArkToolPresentation.decode(.object([
    "card": .string("generic"),
    "title": .string("run"),
    "rawInput": .object(["job": .string("j-1")]),
  ])))
  check(
    rawObject?.rawInput?.contains("\"job\"") == true
      && rawObject?.rawInput?.contains("j-1") == true,
    "native tool keys pretty-print a non-string raw input"
  )

  let terminalCall = terminal(ArkToolPresentation.decode(.object([
    "card": .string("terminal"),
    "title": .string("ls -la"),
    "description": .string("列出目录"),
    "cwd": .string("/w"),
  ])))
  check(
    terminalCall?.title == "ls -la"
      && terminalCall?.description == "列出目录"
      && terminalCall?.cwd == "/w"
      && terminalCall?.output == nil
      && terminalCall?.exitCode == nil,
    "native tool keys decode a terminal call card's header fields"
  )

  let terminalResult = terminal(ArkToolPresentation.decode(.object([
    "card": .string("terminal"),
    "output": .string("total 4"),
    "exitCode": .number(0),
  ])))
  let killed = terminal(ArkToolPresentation.decode(.object([
    "card": .string("terminal"),
    "signal": .string("SIGTERM"),
  ])))
  check(
    terminalResult?.output == "total 4"
      && terminalResult?.exitCode == 0
      && killed?.signal == "SIGTERM"
      && killed?.exitCode == nil,
    "native tool keys decode terminal output and keep signal and exit code distinct"
  )

  let diffCard = diff(ArkToolPresentation.decode(.object([
    "card": .string("diff"),
    "title": .string("Write f.txt"),
    "diffs": .array([
      .object(["path": .string("f.txt"), "oldText": .null, "newText": .string("x")]),
      .object(["path": .string("g.txt"), "oldText": .string("a"), "newText": .string("b")]),
    ]),
  ])))
  check(
    diffCard?.title == "Write f.txt"
      && diffCard?.diffs.count == 2
      && diffCard?.diffs[0].path == "f.txt"
      && diffCard?.diffs[0].oldText == nil
      && diffCard?.diffs[0].newText == "x"
      && diffCard?.diffs[1].oldText == "a",
    "native tool keys decode a diff card and keep a null old text as absent"
  )

  let matches = search(ArkToolPresentation.decode(.object([
    "card": .string("search"),
    "shape": .string("matches"),
    "title": .string("grep foo"),
    "files": .array([
      .object([
        "path": .string("a.ts"),
        "matches": .array([
          .object(["lineNumber": .number(3), "line": .string("foo")]),
          .object(["lineNumber": .number(9), "line": .string("foobar")]),
        ]),
      ]),
    ]),
    "truncated": .bool(true),
    "total": .number(12),
  ])))
  check(
    matches?.shape == "matches"
      && matches?.title == "grep foo"
      && matches?.files.count == 1
      && matches?.files[0].path == "a.ts"
      && matches?.files[0].matches.count == 2
      && matches?.files[0].matches[0].lineNumber == 3
      && matches?.files[0].matches[0].line == "foo"
      && matches?.files[0].matches[1].lineNumber == 9
      && matches?.truncated == true
      && matches?.total == 12,
    "native tool keys group search matches by file with canonical line numbers"
  )

  let legacyMatch = search(ArkToolPresentation.decode(.object([
    "card": .string("search"),
    "shape": .string("matches"),
    "files": .array([
      .object([
        "path": .string("old.ts"),
        "matches": .array([
          .object(["line": .number(3), "text": .string("foo")]),
        ]),
      ]),
    ]),
    "truncated": .bool(false),
    "total": .number(1),
  ])))
  check(
    legacyMatch?.files.first?.matches.isEmpty == true,
    "native tool keys reject a search match without the canonical lineNumber"
  )

  let paths = search(ArkToolPresentation.decode(.object([
    "card": .string("search"),
    "shape": .string("paths"),
    "paths": .array([.string("a.ts"), .string("b.ts")]),
    "truncated": .bool(false),
    "total": .number(2),
  ])))
  check(
    paths?.shape == "paths"
      && paths?.paths == ["a.ts", "b.ts"]
      && paths?.truncated == false,
    "native tool keys decode a flat path search card"
  )

  let readCard = read(ArkToolPresentation.decode(.object([
    "card": .string("read"),
    "title": .string("Read a.ts"),
    "path": .string("/w/a.ts"),
    "offset": .number(11),
    "lines": .array([
      .object(["number": .number(11), "text": .string("let x = 1")]),
    ]),
    "totalLines": .number(40),
    "lang": .string("ts"),
  ])))
  check(
    readCard?.title == "Read a.ts"
      && readCard?.path == "/w/a.ts"
      && readCard?.offset == 11
      && readCard?.lines.count == 1
      && readCard?.lines[0].number == 11
      && readCard?.lines[0].text == "let x = 1"
      && readCard?.totalLines == 40
      && readCard?.lang == "ts",
    "native tool keys decode a read window with canonical numbered lines"
  )
  let routedRead = ArkToolActivity(
    id: "routed-read",
    sequence: 2,
    name: "read_file",
    arguments: "",
    rawCall: .object([:]),
    resultPresentation: .object([
      "card": .string("read"),
      "path": .string("Sources/A.swift"),
      "offset": .number(11),
    ])
  )
  check(
    routedRead.primaryFileLocation == ArkFileLocation(path: "Sources/A.swift", line: 11),
    "native read cards retain their exact path and line for the shared Files owner"
  )

  let legacyLine = read(ArkToolPresentation.decode(.object([
    "card": .string("read"),
    "path": .string("/w/a.ts"),
    "lines": .array([
      .object(["line": .number(3), "text": .string("let y = 2")]),
    ]),
  ])))
  check(
    legacyLine?.lines.isEmpty == true,
    "native tool keys reject a read line without the canonical number"
  )

  let webSearch = web(ArkToolPresentation.decode(.object([
    "card": .string("web"),
    "kind": .string("search"),
    "title": .string("搜索"),
    "sources": .array([
      .object([
        "url": .string("https://example.com/a"),
        "title": .string("A"),
        "snippet": .string("excerpt"),
        "publishedAt": .string("2026-08-01T00:00:00Z"),
      ]),
    ]),
    "answer": .string("答案是 42"),
    "truncated": .bool(false),
  ])))
  check(
    webSearch?.kind == "search"
      && webSearch?.title == "搜索"
      && webSearch?.sources.count == 1
      && webSearch?.sources[0].url == "https://example.com/a"
      && webSearch?.sources[0].title == "A"
      && webSearch?.sources[0].snippet == "excerpt"
      && webSearch?.sources[0].publishedAt == "2026-08-01T00:00:00Z"
      && webSearch?.answer == "答案是 42"
      && webSearch?.truncated == false,
    "native tool keys decode web search sources with snippets and dates"
  )

  let webFetch = web(ArkToolPresentation.decode(.object([
    "card": .string("web"),
    "kind": .string("fetch"),
    "url": .string("https://example.com/b"),
    "statusCode": .number(404),
    "truncated": .bool(true),
  ])))
  check(
    webFetch?.kind == "fetch"
      && webFetch?.url == "https://example.com/b"
      && webFetch?.statusCode == 404
      && webFetch?.truncated == true,
    "native tool keys decode a web fetch retrieval summary"
  )

  check(
    ArkToolPresentation.decode(.object(["card": .string("hologram")])) == nil
      && ArkToolPresentation.decode(.object(["title": .string("x")])) == nil
      && ArkToolPresentation.decode(nil) == nil,
    "native tool keys fall back when a card is unknown or absent"
  )

  var projection = ArkToolProjection()
  projection.append(toolEvent(
    70, "tool/call",
    .object([
      "turn": .number(15), "step": .number(1),
      "callId": .string("call-presented"),
      "name": .string("bash"),
      "arguments": .string(#"{"command":"ls"}"#),
    ]),
    .object(["card": .string("terminal"), "title": .string("ls"), "cwd": .string("/w")])))
  projection.append(toolEvent(
    71, "tool/result",
    .object([
      "turn": .number(15), "step": .number(1),
      "message": .object([
        "content": .array([.object(["type": .string("text"), "text": .string("done")])]),
        "isError": .bool(false),
        "source": .object(["callId": .string("call-presented")]),
      ]),
    ]),
    .object(["card": .string("terminal"), "output": .string("total 0")])))
  check(
    terminal(projection.activities.first?.callView)?.title == "ls"
      && terminal(projection.activities.first?.callView)?.cwd == "/w",
    "native tool keys decode a call envelope onto the stable tool row"
  )
  check(
    terminal(projection.activities.first?.resultView)?.output == "total 0"
      && projection.activities.first?.id == "call-presented",
    "native tool keys decode a result envelope onto the paired call row"
  )

  var mismatched = ArkToolProjection()
  mismatched.append(ArkHistoryEvent(
    id: 72,
    type: "tool/call",
    time: Date(timeIntervalSince1970: 72),
    data: .object([
      "turn": .number(16), "step": .number(1),
      "callId": .string("call-mismatched"),
      "name": .string("bash"),
      "arguments": .string("{}"),
    ]),
    view: .object([
      "for": .string("result"),
      "view": .object(["card": .string("terminal")]),
    ])
  ))
  check(
    mismatched.activities.first?.callView == nil
      && mismatched.activities.first?.resultView == nil,
    "native tool keys ignore a view envelope tagged for the other half"
  )

  let executionEvents = [
    toolEvent(
      100,
      "tool/call",
      .object([
        "turn": .number(20),
        "step": .number(1),
        "callId": .string("root-code"),
        "name": .string("run_code"),
        "arguments": .string("{}"),
      ]),
      .object([
        "card": .string("generic"),
        "title": .string("Run validation"),
        "kind": .string("execute"),
      ])
    ),
    durableEvent(
      101,
      "tool/code-dispatch-start",
      .object([
        "rootCallId": .string("root-code"),
        "parentCallId": .string("root-code"),
        "subCallId": .string("root-code:code:1"),
        "name": .string("run_code"),
        "arguments": .object(["code": .string("await tools.read()")]),
      ])
    ),
    durableEvent(
      102,
      "tool/code-dispatch-start",
      .object([
        "rootCallId": .string("root-code"),
        "parentCallId": .string("root-code:code:1"),
        "subCallId": .string("root-code:code:1:code:1"),
        "name": .string("read"),
        "arguments": .object(["path": .string("a.swift")]),
      ])
    ),
    durableEvent(
      103,
      "tool/code-dispatch",
      .object([
        "rootCallId": .string("root-code"),
        "parentCallId": .string("root-code:code:1"),
        "subCallId": .string("root-code:code:1:code:1"),
        "name": .string("read"),
        "arguments": .object(["path": .string("a.swift")]),
        "isError": .bool(false),
        "content": .array([
          .object(["type": .string("text"), "text": .string("file contents")]),
        ]),
      ])
    ),
    durableEvent(
      104,
      "tool/code-dispatch",
      .object([
        "rootCallId": .string("root-code"),
        "parentCallId": .string("root-code"),
        "subCallId": .string("root-code:code:1"),
        "name": .string("run_code"),
        "arguments": .object(["code": .string("await tools.read()")]),
        "isError": .bool(false),
        "content": .array([
          .object(["type": .string("text"), "text": .string("nested done")]),
        ]),
      ])
    ),
    toolEvent(
      108,
      "tool/result",
      .object([
        "turn": .number(20),
        "step": .number(1),
        "message": .object([
          "content": .array([
            .object(["type": .string("text"), "text": .string("done")]),
          ]),
          "isError": .bool(false),
          "source": .object(["callId": .string("root-code")]),
        ]),
      ]),
      .object([
        "card": .string("terminal"),
        "output": .string("validated"),
        "exitCode": .number(0),
      ])
    ),
  ]
  var incrementalExecution = ArkToolProjection()
  for event in executionEvents { incrementalExecution.append(event) }
  let execution = incrementalExecution.activities.first?.execution
  check(
    execution?.phase == .succeeded
      && execution?.duration() == 8
      && execution?.steps.count == 2
      && execution?.steps[0].parentCallID == "root-code"
      && execution?.steps[0].name == "run_code"
      && execution?.steps[0].phase == .succeeded
      && execution?.steps[0].duration() == 3
      && execution?.steps[0].output == "nested done"
      && execution?.steps[1].parentCallID == "root-code:code:1"
      && execution?.steps[1].name == "read"
      && execution?.steps[1].phase == .succeeded
      && execution?.steps[1].duration() == 1
      && execution?.steps[1].output == "file contents"
      && execution?.completedStepCount == 2,
    "native tool execution folds durable nested dispatch progress, output, and timing"
  )
  check(
    ArkToolProjection(events: executionEvents).activities == incrementalExecution.activities,
    "native tool execution rebuilds the same nested state from persisted history"
  )

  let workflowEvents = [
    toolEvent(
      199,
      "tool/call",
      .object([
        "turn": .number(20), "step": .number(1),
        "callId": .string("workflow-call-1"), "name": .string("workflow"),
        "arguments": .string("{}"),
      ]),
      .object(["card": .string("generic"), "title": .string("workflow")])
    ),
    durableEvent(
      200,
      "tool-workflow/run-start",
      .object([
        "runId": .string("workflow-1"),
        "rootCallId": .string("workflow-call-1"),
        "name": .string("Repository audit"),
      ])
    ),
    durableEvent(
      201,
      "tool-workflow/agent-start",
      .object([
        "runId": .string("workflow-1"),
        "seq": .number(1),
        "label": .string("Inspect files"),
        "phase": .string("discovery"),
        "childId": .string("child-session-1"),
      ])
    ),
    durableEvent(
      205,
      "tool-workflow/agent-end",
      .object([
        "runId": .string("workflow-1"),
        "seq": .number(1),
        "outcome": .string("completed"),
      ])
    ),
    durableEvent(
      206,
      "tool-workflow/agent-start",
      .object([
        "runId": .string("workflow-1"),
        "seq": .number(2),
        "label": .string("Run checks"),
        "childId": .string("child-session-2"),
      ])
    ),
    durableEvent(
      209,
      "tool-workflow/agent-end",
      .object([
        "runId": .string("workflow-1"),
        "seq": .number(2),
        "outcome": .string("failed"),
      ])
    ),
    durableEvent(
      210,
      "tool-workflow/run-end",
      .object(["runId": .string("workflow-1"), "stopReason": .string("error")])
    ),
  ]
  let workflowProjection = ArkToolProjection(events: workflowEvents)
  let workflow = workflowProjection.activities.first { $0.id == "workflow:workflow-1" }
  check(
    workflow?.id == "workflow:workflow-1"
      && workflow?.name == "Repository audit"
      && workflow?.isError == true
      && workflow?.execution?.phase == .failed
      && workflow?.execution?.stopReason == "error"
      && workflow?.execution?.duration() == 10
      && workflow?.execution?.completedStepCount == 2
      && workflow?.execution?.failedStepCount == 1
      && workflow?.turn == 20
      && workflow?.execution?.steps.first?.label == "Inspect files"
      && workflow?.execution?.steps.first?.childSessionID == "child-session-1",
    "native long-task progress is reconstructed only from durable workflow events"
  )

  var running = ArkToolProjection(events: [
    toolEvent(
      300,
      "tool/call",
      .object([
        "turn": .number(30),
        "step": .number(1),
        "callId": .string("running-tool"),
        "name": .string("bash"),
        "arguments": .string("{}"),
      ]),
      .object(["card": .string("terminal"), "title": .string("sleep 10")])
    ),
  ])
  check(
    running.activities.first?.execution?.phase == .running
      && running.activities.first?.execution?.finishedAt == nil,
    "native tool execution keeps an unmatched durable call running"
  )
  running.append(durableEvent(
    301,
    "tool/code-dispatch-start",
    .object([
      "rootCallId": .string("running-tool"),
      "parentCallId": .string("running-tool"),
      "subCallId": .string("running-tool:code:1"),
      "name": .string("wait"),
      "arguments": .object([:]),
    ])
  ))
  running.append(durableEvent(
    304,
    "turn/end",
    .object([
      "turn": .number(30),
      "reason": .object(["kind": .string("aborted")]),
    ])
  ))
  check(
    running.activities.first?.isInterrupted == true
      && running.activities.first?.execution?.phase == .cancelled
      && running.activities.first?.execution?.duration() == 4
      && running.activities.first?.execution?.steps.first?.phase == .cancelled
      && running.activities.first?.execution?.steps.first?.duration() == 3,
    "native tool execution closes an unfinished call from the durable turn boundary"
  )

  let completedWithoutResult = ArkToolProjection(events: [
    toolEvent(
      310,
      "tool/call",
      .object([
        "turn": .number(31),
        "step": .number(1),
        "callId": .string("missing-result"),
        "name": .string("bash"),
        "arguments": .string("{}"),
      ]),
      .object(["card": .string("terminal"), "title": .string("echo done")])
    ),
    durableEvent(
      311,
      "turn/end",
      .object([
        "turn": .number(31),
        "reason": .object(["kind": .string("completed")]),
      ])
    ),
  ])
  check(
    completedWithoutResult.activities.first?.execution?.phase == .cancelled
      && completedWithoutResult.activities.first?.execution?.finishedAt
        == Date(timeIntervalSince1970: 311)
      && completedWithoutResult.activities.first?.execution?.stopReason
        == "missing-result-at-turn-end"
      && completedWithoutResult.activities.first?.isInterrupted == false,
    "native tool execution never remains running after a completed turn loses its result event"
  )

  var crossTurnTools = ArkToolProjection(events: [
    toolEvent(
      320, "tool/call",
      .object([
        "turn": .number(32), "callId": .string("turn-32"),
        "name": .string("bash"), "arguments": .string("{}"),
      ]), .object([:])
    ),
    toolEvent(
      321, "tool/call",
      .object([
        "turn": .number(33), "callId": .string("turn-33"),
        "name": .string("bash"), "arguments": .string("{}"),
      ]), .object([:])
    ),
  ])
  crossTurnTools.append(durableEvent(
    322, "turn/end",
    .object([
      "turn": .number(32),
      "reason": .object(["kind": .string("completed")]),
    ])
  ))
  check(
    crossTurnTools.activities.first(where: { $0.id == "turn-32" })?.execution?.phase
      == .cancelled
      && crossTurnTools.activities.first(where: { $0.id == "turn-33" })?.execution?.phase
        == .running,
    "native tool terminal settlement never crosses turn ownership"
  )
  crossTurnTools.append(durableEvent(
    323, "turn/end",
    .object(["reason": .object(["kind": .string("completed")])])
  ))
  check(
    crossTurnTools.activities.first(where: { $0.id == "turn-33" })?.execution?.phase
      == .running,
    "native ownerless terminal recovery never closes a row with an explicit future turn"
  )

  let ownerlessTerminalCases: [(
    reason: String,
    phase: ArkExecutionPhase,
    isError: Bool,
    isInterrupted: Bool,
    stopReason: String
  )] = [
    ("completed", .cancelled, false, false, "missing-result-at-turn-end"),
    ("error", .failed, true, false, "error"),
    ("cancelled", .cancelled, false, true, "cancelled"),
  ]
  for (offset, expected) in ownerlessTerminalCases.enumerated() {
    let sequence = 324 + offset * 2
    let projection = ArkToolProjection(events: [
      toolEvent(
        sequence, "tool/call",
        .object([
          "callId": .string("ownerless-\(expected.reason)"),
          "name": .string("bash"),
          "arguments": .string("{}"),
        ]), .object([:])
      ),
      durableEvent(
        sequence + 1, "turn/end",
        .object(["reason": .object(["kind": .string(expected.reason)])])
      ),
    ])
    let activity = projection.activities.first
    check(
      activity?.turn == nil
        && activity?.execution?.phase == expected.phase
        && activity?.isError == expected.isError
        && activity?.isInterrupted == expected.isInterrupted
        && activity?.execution?.stopReason == expected.stopReason,
      "native ownerless history recovery settles a \(expected.reason) terminal"
    )
  }

  let ownerlessWithoutTerminal = ArkToolProjection(events: [
    toolEvent(
      338, "tool/call",
      .object([
        "callId": .string("ownerless-no-terminal"),
        "name": .string("bash"),
        "arguments": .string("{}"),
      ]), .object([:])
    ),
  ])
  check(
    ownerlessWithoutTerminal.activities.first?.execution?.phase == .running,
    "native ownerless tool remains running when history has no terminal boundary"
  )

  var ownerlessSequenceBoundary = ArkToolProjection()
  ownerlessSequenceBoundary.append(toolEvent(
    350, "tool/call",
    .object([
      "callId": .string("ownerless-before-terminal"),
      "name": .string("bash"),
      "arguments": .string("{}"),
    ]), .object([:])
  ))
  ownerlessSequenceBoundary.append(toolEvent(
    352, "tool/call",
    .object([
      "turn": .number(51),
      "callId": .string("explicit-future-turn"),
      "name": .string("bash"),
      "arguments": .string("{}"),
    ]), .object([:])
  ))
  ownerlessSequenceBoundary.append(toolEvent(
    353, "tool/call",
    .object([
      "callId": .string("ownerless-after-terminal"),
      "name": .string("bash"),
      "arguments": .string("{}"),
    ]), .object([:])
  ))
  ownerlessSequenceBoundary.append(durableEvent(
    351, "turn/end",
    .object(["reason": .object(["kind": .string("completed")])])
  ))
  check(
    ownerlessSequenceBoundary.activities.first(where: {
      $0.id == "ownerless-before-terminal"
    })?.execution?.phase == .cancelled
      && ownerlessSequenceBoundary.activities.first(where: {
        $0.id == "explicit-future-turn"
      })?.execution?.phase == .running
      && ownerlessSequenceBoundary.activities.first(where: {
        $0.id == "ownerless-after-terminal"
      })?.execution?.phase == .running,
    "native ownerless recovery stops at the terminal sequence and preserves future rows"
  )

  let recoveredFailedTurn = ArkToolProjection(events: [
    durableEvent(330, "turn/start", .object(["turn": .number(34)])),
    toolEvent(
      331, "tool/call",
      .object([
        "callId": .string("active-without-turn"),
        "name": .string("bash"),
        "arguments": .string("{}"),
      ]), .object([:])
    ),
    toolEvent(
      332, "tool/call",
      .object([
        "turn": .number(35),
        "callId": .string("future-turn"),
        "name": .string("bash"),
        "arguments": .string("{}"),
      ]), .object([:])
    ),
    durableEvent(
      333, "turn/end",
      .object(["reason": .object(["kind": .string("error")])])
    ),
  ])
  check(
    recoveredFailedTurn.activities.first(where: { $0.id == "active-without-turn" })?.turn == 34
      && recoveredFailedTurn.activities.first(where: { $0.id == "active-without-turn" })?.isError
        == true
      && recoveredFailedTurn.activities.first(where: { $0.id == "active-without-turn" })?
        .execution?.phase == .failed
      && recoveredFailedTurn.activities.first(where: { $0.id == "active-without-turn" })?
        .execution?.stopReason == "error"
      && recoveredFailedTurn.activities.first(where: { $0.id == "future-turn" })?
        .execution?.phase == .running,
    "native history recovery settles a failed active turn missing wire turn without touching a future turn"
  )

  let recoveredCancelledDispatch = ArkToolProjection(events: [
    durableEvent(340, "turn/start", .object(["turn": .number(40)])),
    durableEvent(
      341, "tool/code-dispatch-start",
      .object([
        "rootCallId": .string("recovered-code"),
        "parentCallId": .string("recovered-code"),
        "subCallId": .string("recovered-code:1"),
        "name": .string("wait"),
        "arguments": .object([:]),
      ])
    ),
    durableEvent(
      342, "turn/end",
      .object(["reason": .object(["kind": .string("cancelled")])])
    ),
  ])
  check(
    recoveredCancelledDispatch.activities.first?.turn == 40
      && recoveredCancelledDispatch.activities.first?.isInterrupted == true
      && recoveredCancelledDispatch.activities.first?.execution?.phase == .cancelled
      && recoveredCancelledDispatch.activities.first?.execution?.steps.first?.phase == .cancelled
      && recoveredCancelledDispatch.activities.first?.execution?.stopReason == "cancelled",
    "native history recovery settles a cancelled active dispatch missing wire turn"
  )
}
