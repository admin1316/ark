import Foundation
import JiuzhangShellCore
import JiuzhangShellUI

func runArkContextMeterContractChecks() {
  check(
    ArkContextPressure(projection: .object([
      "pressureTokens": .number(32_000),
    ]))?.occupancy == nil
      && ArkContextPressure(projection: .object([
        "contextWindow": .number(128_000),
      ]))?.occupancy == nil,
    "context meter stays absent until both pressure and route capacity are known"
  )

  let sampled = ArkContextPressure(projection: .object([
    "pressureTokens": .number(32_000),
    "contextWindow": .number(128_000),
  ]))?.occupancy
  let projected = ArkContextPressure(projection: .object([
    "pressureTokens": .number(32_000),
    "projectedTokens": .number(3_000),
    "contextWindow": .number(128_000),
  ]))?.occupancy
  check(
    sampled == ArkContextOccupancy(usedTokens: 32_000, contextWindow: 128_000, percent: 25)
      && projected == ArkContextOccupancy(usedTokens: 3_000, contextWindow: 128_000, percent: 2),
    "context meter prefers projected next-request pressure so compaction updates immediately"
  )
  check(
    ArkContextPressure(projection: .object([
      "pressureTokens": .number(200_000),
      "contextWindow": .number(128_000),
    ]))?.occupancy?.percent == 100,
    "context meter clamps over-capacity readings to 100 percent"
  )

  let breakdown = ArkContextBreakdown(projection: .object([
    "systemTokens": .number(120),
    "toolsTokens": .number(21_500),
    "messageTokens": .number(477_000),
  ]))
  check(
    breakdown?.total == 498_620
      && ArkContextBreakdown(projection: .object([
        "systemTokens": .number(-1),
        "toolsTokens": .number(0),
        "messageTokens": .number(0),
      ])) == nil,
    "context breakdown accepts only complete nonnegative integer projections"
  )

  let recallSource: JSONValue = .object([
    "kind": .string("session-reference"),
    "form": .string("recall"),
    "references": .array([
      .object(["label": .string("Research")]),
      .object(["label": .string("Research")]),
      .object(["label": .string("Plan")]),
    ]),
  ])
  let instructions = ArkContextProvenance.project(source: .object([
    "kind": .string("agent-instructions"),
    "form": .string("instructions"),
    "changes": .array([.object(["path": .string("AGENTS.md")])]),
  ]))
  let recall = ArkContextProvenance.project(source: recallSource)
  let skill = ArkContextProvenance.project(source: .object([
    "kind": .string("skill-invocation"),
    "name": .string("ponytail"),
    "form": .string("catalog"),
  ]))
  check(
    instructions == ArkContextProvenance(role: .inject, label: "AGENTS.md", form: .instructions)
      && recall == ArkContextProvenance(role: .recall, label: "Research, Plan", form: .recall)
      && skill == ArkContextProvenance(role: .inject, label: "ponytail", form: .catalog),
    "context provenance derives role label and form from durable source metadata"
  )

  var messages = ArkMessageProjection()
  _ = messages.append(ArkHistoryEvent(
    id: 1,
    type: "user/message",
    time: Date(timeIntervalSince1970: 1),
    data: .object([
      "content": .array([.object([
        "type": .string("text"),
        "text": .string("recalled context"),
      ])]),
      "source": recallSource,
    ]),
    view: nil
  ))
  check(
    messages.messages.first?.source == recallSource
      && ArkContextProvenance.project(source: messages.messages.first?.source).role == .recall,
    "native message replay preserves the complete durable context source"
  )

  let rootURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkRootView.swift")
  let contextURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkContextModels.swift")
  let apiURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellCore/ArkAPIClient.swift")
  let l10nURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkL10n.swift")
  guard let root = try? String(contentsOf: rootURL, encoding: .utf8),
        let context = try? String(contentsOf: contextURL, encoding: .utf8),
        let api = try? String(contentsOf: apiURL, encoding: .utf8),
        let l10n = try? String(contentsOf: l10nURL, encoding: .utf8)
  else {
    check(false, "context meter Native sources are readable")
    return
  }
  check(
    root.contains("model.sessionProjections[\"contextPressure\"]")
      && root.contains("model.sessionProjections[\"contextBreakdown\"]")
      && root.contains("ark.context.meter")
      && root.contains("ark.context.panel")
      && !context.contains("Timer")
      && !context.contains("TimelineView"),
    "Native composer renders Host context projections without a polling or animation loop"
  )
  check(
    api.contains("public let source: JSONValue?")
      && api.contains("source: messageValue[\"source\"]")
      && root.contains("ArkContextProvenance.project(source: message.source)")
      && root.contains("provenance.role == .recall"),
    "Native context rows preserve and present durable source provenance"
  )
  check(
    l10n.contains("上下文已用 {0}%")
      && l10n.contains("{0}% of context used")
      && l10n.contains("上下文召回")
      && l10n.contains("Context recall"),
    "context meter and provenance chrome switch through ArkL10n"
  )
}
