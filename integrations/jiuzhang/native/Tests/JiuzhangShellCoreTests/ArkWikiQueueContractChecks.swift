import Foundation

func runArkWikiQueueContractChecks() {
  let apiURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellCore/ArkDomainAPI.swift")
  let modelURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkAppModel.swift")
  let rootURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkRootView.swift")
  let l10nURL = contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkL10n.swift")
  guard
    let api = try? String(contentsOf: apiURL, encoding: .utf8),
    let model = try? String(contentsOf: modelURL, encoding: .utf8),
    let root = try? String(contentsOf: rootURL, encoding: .utf8),
    let l10n = try? String(contentsOf: l10nURL, encoding: .utf8)
  else {
    check(false, "native Wiki queue sources are readable")
    return
  }

  check(
    api.contains("knowledgeWiki/ingestQueueAdd")
      && api.contains("knowledgeWiki/ingestQueueStatus")
      && api.contains("knowledgeWiki/ingestQueueCancel")
      && api.contains("public func enqueueKnowledgeIngest")
      && api.contains("public func knowledgeIngestQueueStatus")
      && api.contains("public func cancelPendingKnowledgeIngests"),
    "native Wiki queue uses the existing typed Host Remote methods"
  )
  check(
    api.contains("let value = try await remoteCall(method: ArkDomainAPIContract.Method.knowledgeIngestQueueCancel)")
      && api.contains("for _ in 0...snapshot.tasks.count") == false
      && api.contains("current Host verb cancels one pending task per call") == false,
    "native Wiki cancel delegates once to the atomic Host queue owner"
  )

  let polling = sourceSlice(
    model,
    from: "private func startKnowledgeIngestPolling()",
    through: "private func stopKnowledgeIngestPolling"
  )
  check(
    polling?.contains("Task.sleep") == true
      && polling?.contains("delay = min(delay * 2, 5)") == true
      && polling?.contains("if !snapshot.hasActiveTasks") == true
      && polling?.contains("await loadWiki(refreshIngestQueue: false)") == true
      && polling?.contains("Timer") == false
      && polling?.contains("TimelineView") == false,
    "native Wiki queue polls only while active, backs off, and refreshes once on completion"
  )
  check(
    model.contains("ArkHTTPURLInput.normalizedHTTPURL(rawValue)")
      && model.contains("client.enqueueKnowledgeIngest(inputs: [normalized])")
      && model.contains("installKnowledgeIngestQueue(queue)"),
    "native Wiki URL import validates then joins the single queue owner"
  )

  let queueView = sourceSlice(
    root,
    from: "private struct NativeWikiIngestQueueView",
    through: "private struct NativeWikiGraph"
  )
  check(
    queueView?.contains("queue.tasks.suffix(4)") == true
      && queueView?.contains("ark.wiki.ingest.refresh") == true
      && queueView?.contains("ark.wiki.ingest.cancel-pending") == true
      && queueView?.contains("model.cancelPendingKnowledgeIngests()") == true,
    "native Wiki left column presents bounded queue status refresh and pending cancellation"
  )
  check(
    root.contains("ark.wiki.ingest.url")
      && root.contains("ark.wiki.ingest.url-error")
      && root.contains("model.importKnowledgeURL(value)")
      && root.contains("private var importURLValidationError: String?")
      && root.contains("ArkHTTPURLInput.normalizedHTTPURL(value) == nil")
      && root.contains("@State private var importURLError") == false
      && root.contains(".frame(minHeight: 18)")
      && root.contains(".frame(width: 520, height: 210)")
      && root.contains(".onChange(of: importURL)") == false
      && root.contains("showImportURL = false"),
    "native Wiki URL validation is a pure projection without duplicate error state"
  )

  let review = sourceSlice(
    root,
    from: "private struct NativeWikiDetail",
    through: "private struct NativeDetailsPlaceholder"
  )
  check(
    review?.contains("ark.wiki.review.bulk-ignore") == true
      && review?.contains("showBulkIgnoreConfirmation") == true
      && review?.contains("model.resolveReviews(unresolvedReviews.map(\\.id), action: \"Skip\")") == true
      && review?.contains("role: .destructive") == true,
    "native Wiki bulk review is explicit, confirmed, and scoped to unresolved items"
  )
  check(
    l10n.contains("从 URL 导入…")
      && l10n.contains("Import from URL…")
      && l10n.contains("取消待处理")
      && l10n.contains("Cancel Pending")
      && l10n.contains("全部忽略")
      && l10n.contains("Ignore All"),
    "native Wiki queue and bulk review chrome switch through ArkL10n"
  )
}

private func sourceSlice(
  _ source: String,
  from start: String,
  through end: String
) -> String? {
  guard
    let startRange = source.range(of: start),
    let endRange = source.range(
      of: end,
      range: startRange.lowerBound..<source.endIndex
    )
  else { return nil }
  return String(source[startRange.lowerBound..<endRange.upperBound])
}
