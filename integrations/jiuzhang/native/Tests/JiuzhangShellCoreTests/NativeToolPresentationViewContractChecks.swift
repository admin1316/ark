import Foundation

/// Source-level contract for NativeToolPresentationView: the view consumes the
/// typed ArkToolPresentation cards via callView/resultView and carries no
/// ad-hoc JSON key reads or legacy line fallbacks.
func runNativeToolPresentationViewContractChecks() {
  let viewURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeToolPresentationView.swift"
  )
  let executionURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeExecutionActivityView.swift"
  )
  let rootURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  guard
    let source = try? String(contentsOf: viewURL, encoding: .utf8),
    let execution = try? String(contentsOf: executionURL, encoding: .utf8),
    let root = try? String(contentsOf: rootURL, encoding: .utf8)
  else {
    check(false, "native tool presentation view source is readable for contract checks")
    return
  }

  for banned in [
    "JSONValue", "callPresentation", "resultPresentation",
    "[\"card\"]", "[\"title\"]", "[\"description\"]", "[\"cwd\"]",
    "[\"output\"]", "[\"signal\"]", "[\"exitCode\"]", "[\"diffs\"]",
    "[\"path\"]", "[\"lines\"]", "[\"line\"]", "[\"lineNumber\"]",
    "[\"number\"]", "[\"text\"]", "[\"paths\"]", "[\"files\"]",
    "[\"matches\"]", "[\"sources\"]", "[\"answer\"]", "[\"url\"]",
  ] {
    check(
      !source.contains(banned),
      "native tool presentation view carries no \(banned) JSON key read"
    )
  }

  check(
    source.contains("activity.callView") && source.contains("activity.resultView"),
    "native tool presentation view consumes typed callView and resultView cards"
  )
  check(
    source.contains("activity.structuredView")
      && source.contains("case .todo(let list)")
      && source.contains("case .questions(let batch)")
      && source.contains("todoCounts(list)")
      && source.contains("if activity.isError")
      && source.contains("question.options"),
    "native tool presentation renders typed todo and user-question cards instead of raw JSON"
  )
  for card in [".generic", ".terminal", ".diff", ".search", ".read", ".web"] {
    check(
      source.contains("case \(card)"),
      "native tool presentation view renders the \(card) card case"
    )
  }
  check(
    source.contains("switch presentation"),
    "native tool presentation view switches on the decoded presentation"
  )
  check(
    source.contains("NativeExecutionActivityView(")
      && source.contains("openChildSession: openChildSession"),
    "native tool presentation embeds durable execution state in the existing chat tool path"
  )
  check(
    root.contains("NativeExecutionInlineStatusView(activity: activity, language: language)")
      && root.contains("activity.execution?.steps.isEmpty == false"),
    "native collapsed tool rows keep durable phase, duration, and nested progress visible"
  )
  check(
    execution.contains("activity.execution")
      && execution.contains("execution.completedStepCount")
      && execution.contains("execution.failedStepCount")
      && execution.contains("TimelineView(.periodic(from: .now, by: 1))")
      && execution.components(separatedBy: "TimelineView(.periodic(from: .now, by: 1))").count == 4
      && execution.contains("Image(systemName: \"circle.dotted\")")
      && !execution.contains("ProgressView().controlSize(.mini)")
      && execution.contains("detail(execution, now: context.date)")
      && execution.contains("stepRow(step, steps: execution.steps, now: now)")
      && execution.contains("step.parentCallID")
      && execution.contains("step.output")
      && execution.contains("terminal.exitCode")
      && execution.contains("terminal.signal")
      && execution.contains("退出码")
      && execution.contains("stepsExpanded.toggle()"),
    "native execution rows show durable progress, live duration, output, and nested collapse state"
  )
  check(
    execution.contains("ark.chat.tool.execution.\\(activity.id)")
      && execution.contains("ark.chat.tool.execution.detail.\\(activity.id)")
      && execution.contains("ark.chat.tool.execution.steps.\\(activity.id)")
      && execution.contains("ark.chat.tool.execution.step.\\(step.id)")
      && execution.contains(".accessibilityLabel(step.label ?? step.name)")
      && execution.contains(".accessibilityValue(stepAccessibilityValue(step, now: now))"),
    "native execution progress, nested output, timing, and disclosure remain explicit to AX"
  )
  check(
    !execution.contains("assistant")
      && !execution.contains("message.text")
      && !execution.contains("contains(\"running\")")
      && !execution.contains("contains(\"完成\")"),
    "native execution presentation never infers state from assistant free text"
  )
}
