import AppKit
import Combine
import SwiftUI

/// Stable SwiftUI-facing owner for chat scroll state. Keep this controller
/// above a tab/session-specific chat subtree so detaching and reattaching an
/// `NSScrollView` does not discard per-session positions.
@MainActor
public final class ArkChatScrollController: ObservableObject {
  @Published public private(set) var isAtBottom = true

  private weak var attachedScrollView: NSScrollView?
  private var coordinator: ArkChatScrollCoordinator?
  private var retainedStateMachine: ArkChatScrollStateMachine
  private var requestedSessionID: String?

  public init(followThreshold: Double = 24) {
    retainedStateMachine = ArkChatScrollStateMachine(followThreshold: followThreshold)
  }

  /// Attach to the AppKit scroll view discovered by
  /// ``ArkChatScrollAttachment``. Repeated discovery of the same view is a no-op.
  public func attach(to scrollView: NSScrollView) {
    if attachedScrollView === scrollView { return }
    detach()
    attachedScrollView = scrollView
    let coordinator = ArkChatScrollCoordinator(
      scrollView: scrollView,
      stateMachine: retainedStateMachine
    )
    coordinator.onFollowingBottomChange = { [weak self] followsBottom in
      self?.setAtBottom(followsBottom)
    }
    self.coordinator = coordinator
    if let requestedSessionID { coordinator.activate(sessionID: requestedSessionID) }
    synchronizeFromCoordinator()
  }

  /// Detach only when `scrollView` is the controller's current attachment.
  /// Passing nil detaches unconditionally.
  public func detach(from scrollView: NSScrollView? = nil) {
    if let scrollView, attachedScrollView !== scrollView { return }
    detach()
  }

  public func activate(sessionID: String) {
    requestedSessionID = sessionID
    coordinator?.activate(sessionID: sessionID)
    synchronizeFromCoordinator()
  }

  /// Two-phase alternative for a declarative transcript replacement. Begin
  /// before changing the SwiftUI session and complete after its AppKit document
  /// has laid out, so incoming geometry is never recorded against the old id.
  public func beginSessionTransition(to sessionID: String) {
    requestedSessionID = sessionID
    coordinator?.beginSessionTransition(to: sessionID)
  }

  public func completeSessionTransition() {
    coordinator?.completeSessionTransition()
    synchronizeFromCoordinator()
  }

  public func contentDidChange() {
    coordinator?.contentDidChange()
    synchronizeFromCoordinator()
  }

  public func capturePrependAnchor(
    visibleAnchor: ArkChatScrollContentAnchor? = nil
  ) -> ArkChatScrollPrependAnchor? {
    coordinator?.capturePrependAnchor(visibleAnchor: visibleAnchor)
  }

  public func restoreAfterPrepend(
    _ anchor: ArkChatScrollPrependAnchor,
    resolvedAnchor: ArkChatScrollContentAnchor? = nil
  ) {
    coordinator?.restoreAfterPrepend(anchor, resolvedAnchor: resolvedAnchor)
    synchronizeFromCoordinator()
  }

  public func scrollBottom() {
    coordinator?.scrollToBottom()
    synchronizeFromCoordinator()
  }

  public func snapshot(for sessionID: String) -> ArkChatScrollSessionSnapshot? {
    coordinator?.snapshot(for: sessionID) ?? retainedStateMachine.snapshot(for: sessionID)
  }

  public func removeSession(_ sessionID: String) {
    if requestedSessionID == sessionID { requestedSessionID = nil }
    if let coordinator {
      coordinator.removeSession(sessionID)
      synchronizeFromCoordinator()
    } else {
      retainedStateMachine.removeSession(sessionID)
      setAtBottom(true)
    }
  }

  private func detach() {
    guard let coordinator else {
      attachedScrollView = nil
      return
    }
    retainedStateMachine = coordinator.stateMachine
    coordinator.onFollowingBottomChange = nil
    coordinator.invalidate()
    self.coordinator = nil
    attachedScrollView = nil
    synchronizeFromRetainedState()
  }

  private func synchronizeFromCoordinator() {
    guard let coordinator else {
      synchronizeFromRetainedState()
      return
    }
    retainedStateMachine = coordinator.stateMachine
    setAtBottom(coordinator.followsBottom)
  }

  private func synchronizeFromRetainedState() {
    guard let requestedSessionID else {
      setAtBottom(true)
      return
    }
    setAtBottom(retainedStateMachine.snapshot(for: requestedSessionID)?.followsBottom ?? true)
  }

  /// `@Published` emits even when a value is assigned to itself. AppKit frame
  /// notifications can arrive while SwiftUI is laying out the transcript, so
  /// publishing an unchanged following state creates a layout -> notification
  /// -> publish -> layout feedback loop. Only semantic transitions may wake the
  /// SwiftUI tree.
  private func setAtBottom(_ value: Bool) {
    guard isAtBottom != value else { return }
    isAtBottom = value
  }
}

/// Zero-size SwiftUI probe that discovers the enclosing AppKit scroll view.
/// Place it anywhere inside the transcript `ScrollView` content, for example
/// as a ZStack overlay. It has no drawing, hit-testing, or accessibility face.
public struct ArkChatScrollAttachment: NSViewRepresentable {
  private let controller: ArkChatScrollController

  public init(controller: ArkChatScrollController) {
    self.controller = controller
  }

  public func makeNSView(context: Context) -> NSView {
    let view = ArkChatScrollAttachmentView()
    view.update(controller: controller)
    return view
  }

  public func updateNSView(_ nsView: NSView, context: Context) {
    (nsView as? ArkChatScrollAttachmentView)?.update(controller: controller)
  }

  public static func dismantleNSView(_ nsView: NSView, coordinator: Void) {
    (nsView as? ArkChatScrollAttachmentView)?.dismantle()
  }
}

@MainActor
private final class ArkChatScrollAttachmentView: NSView {
  private weak var controller: ArkChatScrollController?
  private weak var attachedScrollView: NSScrollView?
  private var attachmentScheduled = false

  override var intrinsicContentSize: NSSize { .zero }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func viewDidMoveToSuperview() {
    super.viewDidMoveToSuperview()
    scheduleAttachment()
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    scheduleAttachment()
  }

  override func layout() {
    super.layout()
    // `attach(to:)` may publish the initial following state. AppKit invokes
    // layout while SwiftUI is updating this representable, so attaching here
    // would publish from inside the active view transaction. Defer through the
    // same single-flight boundary used by move/update callbacks.
    if attachedScrollView == nil { scheduleAttachment() }
  }

  func update(controller: ArkChatScrollController) {
    if self.controller !== controller {
      self.controller?.detach(from: attachedScrollView)
      attachedScrollView = nil
      self.controller = controller
    }
    scheduleAttachment()
  }

  func dismantle() {
    controller?.detach(from: attachedScrollView)
    attachedScrollView = nil
    controller = nil
  }

  private func scheduleAttachment() {
    guard !attachmentScheduled else { return }
    attachmentScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.attachmentScheduled = false
      self.attachIfPossible()
    }
  }

  private func attachIfPossible() {
    guard let controller, let scrollView = enclosingScrollView else { return }
    attachedScrollView = scrollView
    controller.attach(to: scrollView)
  }
}
