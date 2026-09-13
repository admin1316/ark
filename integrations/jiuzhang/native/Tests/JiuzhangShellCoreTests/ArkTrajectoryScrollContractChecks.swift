import AppKit
import JiuzhangShellCore
import JiuzhangShellUI

/// AppKit document view with the flipped convention the transcript and ledger use.
private final class ArkScrollContractDocument: NSView {
  override var isFlipped: Bool { true }
}

private struct ArkScrollSurface {
  let scrollView: NSScrollView
  let document: ArkScrollContractDocument

  @MainActor var offset: Double {
    let visible = scrollView.documentVisibleRect
    return document.isFlipped
      ? Double(visible.minY - document.bounds.minY)
      : Double(document.bounds.maxY - visible.maxY)
  }

  @MainActor var contentHeight: Double { Double(document.bounds.height) }

  @MainActor var viewportHeight: Double { Double(scrollView.contentView.bounds.height) }
}

@MainActor
private func makeArkScrollSurface(content: CGFloat, viewport: CGFloat) -> ArkScrollSurface {
  let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: viewport))
  scrollView.hasVerticalScroller = true
  scrollView.postsBoundsChangedNotifications = true
  let document = ArkScrollContractDocument(
    frame: NSRect(x: 0, y: 0, width: 400, height: content)
  )
  scrollView.documentView = document
  scrollView.contentView.postsBoundsChangedNotifications = true
  scrollView.layoutSubtreeIfNeeded()
  return ArkScrollSurface(scrollView: scrollView, document: document)
}

/// Deliver one geometry change the way AppKit does, then let the main queue drain.
@MainActor
private func arkDeliverGeometry(_ surface: ArkScrollSurface) {
  surface.scrollView.contentView.postsBoundsChangedNotifications = true
  NotificationCenter.default.post(
    name: NSView.boundsDidChangeNotification,
    object: surface.scrollView.contentView
  )
  RunLoop.main.run(until: Date().addingTimeInterval(0.03))
}

/// Simulate lazy rows materializing: only the document height changes.
@MainActor
private func arkMaterialize(
  _ surface: ArkScrollSurface,
  to height: CGFloat,
  label: String,
  trace: inout [String]
) {
  surface.document.frame = NSRect(
    x: 0,
    y: 0,
    width: surface.document.frame.width,
    height: height
  )
  arkDeliverGeometry(surface)
  trace.append(
    "\(label): content=\(Int(surface.contentHeight)) viewport=\(Int(surface.viewportHeight)) offset=\(Int(surface.offset))"
  )
}

/// Simulate a real viewport resize (window / split-pane).
@MainActor
private func arkResizeViewport(
  _ surface: ArkScrollSurface,
  to height: CGFloat,
  label: String,
  trace: inout [String]
) {
  surface.scrollView.frame = NSRect(
    x: 0,
    y: 0,
    width: surface.scrollView.frame.width,
    height: height
  )
  surface.scrollView.contentView.frame = NSRect(
    x: 0,
    y: 0,
    width: surface.scrollView.frame.width,
    height: height
  )
  surface.scrollView.layoutSubtreeIfNeeded()
  arkDeliverGeometry(surface)
  trace.append(
    "\(label): content=\(Int(surface.contentHeight)) viewport=\(Int(surface.viewportHeight)) offset=\(Int(surface.offset))"
  )
}

private func arkAnchorLabel(_ anchor: ArkScrollAnchor) -> String {
  switch anchor {
  case .bottom: return "bottom"
  case .top: return "top"
  }
}

private func arkBoolLabel(_ value: Bool?) -> String {
  guard let value else { return "nil" }
  return value ? "true" : "false"
}

/// Reproduces the reported trajectory first-open blank and guards chat tail semantics.
///
/// Event sequence reproduced here (the bug): a fresh trajectory surface activates with
/// chat tail-anchoring, materializing lazy rows re-pins the table to the *estimated*
/// document bottom and arms the one-shot reflow suppression, and the following
/// materialization resize is swallowed, so the recorded anchor no longer matches the
/// real document and the viewport can sit on unmaterialized space until a real scroll.
@MainActor
func runArkTrajectoryScrollContractChecks() {
  // ---- Scenario T: the trajectory ledger must be top-anchored -------------------------
  var trace: [String] = []
  let trajectory = makeArkScrollSurface(content: 300, viewport: 300)
  let trajectoryController = ArkChatScrollController(followThreshold: 24, anchor: .top)
  trajectoryController.attach(to: trajectory.scrollView)
  trajectoryController.activate(sessionID: "trajectory:session-1")
  trace.append(
    "activate(anchor=.top): offset=\(Int(trajectory.offset)) followsBottom="
      + arkBoolLabel(trajectoryController.snapshot(for: "trajectory:session-1")?.followsBottom)
  )
  arkMaterialize(trajectory, to: 4_000, label: "materialize-1", trace: &trace)
  arkMaterialize(trajectory, to: 6_000, label: "materialize-2", trace: &trace)
  let trajectorySnapshot = trajectoryController.snapshot(for: "trajectory:session-1")
  trace.append(
    "final(anchor=.top): offset=\(Int(trajectory.offset)) followsBottom="
      + arkBoolLabel(trajectorySnapshot?.followsBottom)
      + " recordedContent=\(Int(trajectorySnapshot?.contentHeight ?? -1))"
      + " realContent=\(Int(trajectory.contentHeight))"
  )
  print("[trajectory-scroll-trace] surface=trajectory anchor=\(arkAnchorLabel(trajectoryController.anchor))")
  for line in trace { print("[trajectory-scroll-trace] \(line)") }

  check(
    trajectory.offset == 0,
    "trajectory keeps its top anchor after lazy rows materialize (offset=\(Int(trajectory.offset)))"
  )
  check(
    trajectorySnapshot?.followsBottom == false,
    "trajectory surface never follows the document bottom"
  )
  check(
    trajectorySnapshot?.contentHeight == 6_000,
    "trajectory observes the materialization resize instead of swallowing it "
      + "(recorded=\(Int(trajectorySnapshot?.contentHeight ?? -1)))"
  )

  // ---- Scenario R: chat keeps tail-following semantics --------------------------------
  var chatTrace: [String] = []
  let chat = makeArkScrollSurface(content: 300, viewport: 300)
  let chatController = ArkChatScrollController()
  chatController.attach(to: chat.scrollView)
  chatController.activate(sessionID: "chat:session-1")
  chatTrace.append(
    "activate(anchor=.bottom): offset=\(Int(chat.offset)) followsBottom="
      + arkBoolLabel(chatController.snapshot(for: "chat:session-1")?.followsBottom)
  )
  arkMaterialize(chat, to: 4_000, label: "chat-materialize", trace: &chatTrace)
  check(
    chat.offset == 3_700,
    "chat still pins to the materialized bottom (offset=\(Int(chat.offset)))"
  )
  arkResizeViewport(chat, to: 200, label: "chat-viewport-shrink", trace: &chatTrace)
  let chatSnapshot = chatController.snapshot(for: "chat:session-1")
  chatTrace.append(
    "final(anchor=.bottom): offset=\(Int(chat.offset)) followsBottom="
      + arkBoolLabel(chatSnapshot?.followsBottom)
      + " recordedContent=\(Int(chatSnapshot?.contentHeight ?? -1))"
  )
  print("[trajectory-scroll-trace] surface=chat anchor=\(arkAnchorLabel(chatController.anchor))")
  for line in chatTrace { print("[trajectory-scroll-trace] \(line)") }

  check(
    chat.offset == 3_800,
    "a real viewport resize is never swallowed by the reflow suppression "
      + "(offset=\(Int(chat.offset)) after shrinking 300->200)"
  )
  check(
    chatSnapshot?.contentHeight == 4_000 && chatSnapshot?.followsBottom == true,
    "chat retains its tail anchor and records the materialized content height"
  )
}


/// Scenario matrix required by ARK-TRAJECTORY-SCROLL-FIX: session switch, load-earlier
/// prepend, records refresh, window resize, and panel resize on a top-anchored ledger.
@MainActor
func runArkTrajectoryScrollScenarioChecks() {
  var trace: [String] = []
  let surface = makeArkScrollSurface(content: 300, viewport: 300)
  let controller = ArkChatScrollController(followThreshold: 24, anchor: .top)
  controller.attach(to: surface.scrollView)

  controller.activate(sessionID: "trajectory:s1")
  arkMaterialize(surface, to: 4_000, label: "s1-materialize", trace: &trace)
  check(
    surface.offset == 0,
    "first session keeps the top anchor (offset=\(Int(surface.offset)))"
  )

  controller.activate(sessionID: "trajectory:s2")
  arkMaterialize(surface, to: 3_000, label: "s2-materialize", trace: &trace)
  check(
    surface.offset == 0,
    "a switched-in session starts at the top (offset=\(Int(surface.offset)))"
  )
  check(
    controller.snapshot(for: "trajectory:s2")?.contentHeight == 3_000,
    "the switched session records its own content height"
  )

  controller.activate(sessionID: "trajectory:s1")
  check(
    surface.offset == 0,
    "switching back keeps the top anchor (offset=\(Int(surface.offset)))"
  )

  arkMaterialize(surface, to: 5_000, label: "s1-refresh", trace: &trace)
  controller.contentDidChange()
  arkDeliverGeometry(surface)
  check(
    surface.offset == 0,
    "records refresh does not yank a top-anchored reader (offset=\(Int(surface.offset)))"
  )
  check(
    controller.snapshot(for: "trajectory:s1")?.contentHeight == 5_000,
    "records refresh records the new content height"
  )

  let prependAnchor = controller.capturePrependAnchor()
  check(prependAnchor != nil, "load-earlier captures a prepend anchor")
  arkMaterialize(surface, to: 6_200, label: "prepend-insert", trace: &trace)
  if let prependAnchor { controller.restoreAfterPrepend(prependAnchor) }
  check(
    surface.offset == 1_200,
    "load-earlier keeps the previously visible row (offset=\(Int(surface.offset)))"
  )
  check(
    controller.snapshot(for: "trajectory:s1")?.followsBottom == false,
    "load-earlier never re-enables tail following"
  )

  arkResizeViewport(surface, to: 220, label: "window-resize", trace: &trace)
  check(
    surface.offset == 1_200,
    "window resize keeps the reader anchor (offset=\(Int(surface.offset)))"
  )
  arkResizeViewport(surface, to: 420, label: "panel-resize", trace: &trace)
  check(
    surface.offset == 1_200,
    "panel resize keeps the reader anchor (offset=\(Int(surface.offset)))"
  )
  check(
    controller.snapshot(for: "trajectory:s1")?.followsBottom == false,
    "resizes never flip a reader back to the tail"
  )

  // tab roundtrip: leaving and re-entering the ledger swaps the NSScrollView while the
  // controller retains the per-session anchor
  controller.detach(from: surface.scrollView)
  let revisited = makeArkScrollSurface(content: 6_200, viewport: 300)
  controller.attach(to: revisited.scrollView)
  controller.activate(sessionID: "trajectory:s3")
  check(
    revisited.offset == 0,
    "tab roundtrip opens a fresh ledger session at the top (offset=\(Int(revisited.offset)))"
  )
  arkMaterialize(revisited, to: 7_400, label: "roundtrip-materialize", trace: &trace)
  check(
    revisited.offset == 0,
    "tab roundtrip materialization keeps the top anchor (offset=\(Int(revisited.offset)))"
  )
  check(
    controller.snapshot(for: "trajectory:s3")?.followsBottom == false,
    "tab roundtrip never re-enables tail following"
  )
  // Re-entering the session that had paged older history must restore its reading
  // anchor, not the tail.
  controller.activate(sessionID: "trajectory:s1")
  check(
    revisited.offset == 1_200,
    "tab roundtrip restores the retained reading anchor (offset=\(Int(revisited.offset)))"
  )

  print("[trajectory-scroll-trace] surface=trajectory-scenarios")
  for line in trace { print("[trajectory-scroll-trace] \(line)") }
}
