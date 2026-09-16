import Foundation
@testable import JiuzhangShellUI

/// The collapsed Think row must read as prose: inline Markdown markers belong to
/// the expanded body, never to the one-line summary.
func runArkReasoningSummaryContractChecks() {
  func summary(_ text: String) -> String {
    ArkStreamingPresentationPolicy.reasoningSummary(text, fallback: "Thought")
  }

  // Settled text: the newest non-empty line wins and its bold markers are stripped.
  let settled = summary("**Comparing checkout and merge bases**\nKeep **reviewing**")
  precondition(settled == "Keep reviewing", "settled summary was \(settled)")

  // Streaming text with a trailing blank line still summarises the last real line.
  let streaming = summary("first line\n**latest line**\n")
  precondition(streaming == "latest line", "streaming summary was \(streaming)")

  // A long line is bounded, and the ellipsis is not counted as content.
  let long = summary(String(repeating: "a", count: 200))
  precondition(long.count == 64, "bounded summary length was \(long.count)")
  precondition(long.hasSuffix("…"), "bounded summary lost its ellipsis")

  // No useable line falls back to the localised placeholder.
  precondition(summary("   \n\n") == "Thought", "fallback was not applied")

  // Expanded content is untouched: markers survive for the Markdown renderer.
  let expanded = ArkStreamingPresentationPolicy.reasoningText("**bold**", streaming: false)
  precondition(expanded == "**bold**", "expanded reasoning text was rewritten")
}

