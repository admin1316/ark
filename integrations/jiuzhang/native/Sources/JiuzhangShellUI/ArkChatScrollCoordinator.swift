import AppKit
import Foundation

/// Geometry observed by the chat scroll state machine. `offset` is normalized
/// from the top of the document and always increases toward the bottom,
/// independently of whether the AppKit document view is flipped.
public struct ArkChatScrollMetrics: Equatable, Sendable {
  public let contentHeight: Double
  public let viewportHeight: Double
  public let offset: Double

  public init(contentHeight: Double, viewportHeight: Double, offset: Double) {
    self.contentHeight = Self.nonnegativeFinite(contentHeight)
    self.viewportHeight = Self.nonnegativeFinite(viewportHeight)
    self.offset = Self.finite(offset)
  }

  public var maximumOffset: Double {
    max(contentHeight - viewportHeight, 0)
  }

  public var clampedOffset: Double {
    min(max(offset, 0), maximumOffset)
  }

  public var distanceFromBottom: Double {
    max(maximumOffset - clampedOffset, 0)
  }

  private static func finite(_ value: Double) -> Double {
    value.isFinite ? value : 0
  }

  private static func nonnegativeFinite(_ value: Double) -> Double {
    max(finite(value), 0)
  }
}

/// Why the visible origin moved. Only direct user movement may suspend or
/// restore bottom following; coordinator-owned moves preserve the chosen mode.
public enum ArkChatScrollMoveSource: Equatable, Sendable {
  case user
  case programmatic
}

/// One geometry operation requested by the pure state machine.
public enum ArkChatScrollCommand: Equatable, Sendable {
  case none
  case scrollToBottom
  case scrollTo(offset: Double)
}

/// Pure routing rule for a wheel event that landed in a nested horizontal
/// scroller such as a Markdown table or code block. A vertical gesture must
/// keep driving the transcript; a horizontal gesture remains owned by the
/// nested surface, and a genuinely vertical nested surface keeps its event.
public enum ArkChatNestedScrollRouting {
  public static func forwardsToTranscript(
    deltaX: Double,
    deltaY: Double,
    horizontalRange: Double,
    verticalRange: Double
  ) -> Bool {
    let horizontal = abs(deltaX.isFinite ? deltaX : 0)
    let vertical = abs(deltaY.isFinite ? deltaY : 0)
    return vertical > horizontal
      && vertical > 0
      && horizontalRange.isFinite
      && horizontalRange > 0.5
      && (!verticalRange.isFinite || verticalRange <= 0.5)
  }
}

/// Read-only diagnostics for one session's independent scroll position.
public struct ArkChatScrollSessionSnapshot: Equatable, Sendable {
  public let followsBottom: Bool
  public let offset: Double
  public let contentHeight: Double
}

/// Stable semantic row observed inside the document before/after prepend.
/// `documentOffset` is its top-normalized vertical position. Supplying this
/// lets the state machine survive reflow as well as a simple height delta.
public struct ArkChatScrollContentAnchor: Equatable, Sendable {
  public let id: String
  public let documentOffset: Double

  public init(id: String, documentOffset: Double) {
    self.id = id
    self.documentOffset = documentOffset.isFinite ? documentOffset : 0
  }
}

/// Token captured before older history is inserted above the viewport.
/// Completing a stale token after the user moves is deliberately a no-op.
public struct ArkChatScrollPrependAnchor: Equatable, Sendable {
  public let sessionID: String
  fileprivate let contentHeight: Double
  fileprivate let offset: Double
  fileprivate let followedBottom: Bool
  fileprivate let userRevision: UInt64
  fileprivate let generation: UInt64
  fileprivate let semanticID: String?
  fileprivate let semanticViewportOffset: Double?
}

/// Pure, AppKit-independent chat scroll policy with one retained position per
/// session. The state machine knows only normalized geometry; callers execute
/// the returned commands and report the resulting viewport as programmatic.
public struct ArkChatScrollStateMachine: Sendable {
  private struct SessionState: Sendable {
    var followsBottom = true
    var offset = 0.0
    var contentHeight = 0.0
    var userRevision: UInt64 = 0
    var prependGeneration: UInt64 = 0
  }

  public private(set) var activeSessionID: String?
  public let followThreshold: Double
  private var sessions: [String: SessionState] = [:]

  public init(followThreshold: Double = 24) {
    self.followThreshold = max(followThreshold.isFinite ? followThreshold : 0, 0)
  }

  /// Activate a session after its document has been laid out. New sessions
  /// start at the bottom; known sessions restore their own retained position.
  public mutating func activate(
    sessionID: String,
    metrics: ArkChatScrollMetrics
  ) -> ArkChatScrollCommand {
    activeSessionID = sessionID
    guard var state = sessions[sessionID] else {
      sessions[sessionID] = SessionState(
        followsBottom: true,
        offset: metrics.maximumOffset,
        contentHeight: metrics.contentHeight
      )
      return .scrollToBottom
    }
    state.contentHeight = metrics.contentHeight
    if state.followsBottom {
      state.offset = metrics.maximumOffset
      sessions[sessionID] = state
      return .scrollToBottom
    }
    state.offset = min(max(state.offset, 0), metrics.maximumOffset)
    if metrics.maximumOffset == 0 {
      state.followsBottom = true
      sessions[sessionID] = state
      return .scrollToBottom
    }
    sessions[sessionID] = state
    return .scrollTo(offset: state.offset)
  }

  /// Observe a viewport move. A user farther than the threshold from the
  /// bottom suspends following; reaching the threshold restores it.
  public mutating func viewportDidMove(
    sessionID: String,
    metrics: ArkChatScrollMetrics,
    source: ArkChatScrollMoveSource
  ) {
    var state = sessions[sessionID] ?? SessionState()
    state.offset = metrics.clampedOffset
    state.contentHeight = metrics.contentHeight
    if source == .user {
      state.userRevision &+= 1
      state.followsBottom = metrics.distanceFromBottom <= followThreshold
    }
    sessions[sessionID] = state
  }

  /// Reconcile a programmatic change to the document or viewport geometry.
  /// A resize is not user intent: following sessions stay at the new bottom,
  /// while readers away from the bottom retain their top-normalized anchor.
  /// In particular this does not advance `userRevision`, so an in-flight
  /// prepend token remains valid across composer/window/split-view resizing.
  public mutating func viewportDidResize(
    sessionID: String,
    metrics: ArkChatScrollMetrics
  ) -> ArkChatScrollCommand {
    var state = sessions[sessionID] ?? SessionState()
    state.contentHeight = metrics.contentHeight

    if state.followsBottom || metrics.maximumOffset == 0 {
      state.followsBottom = true
      state.offset = metrics.maximumOffset
      sessions[sessionID] = state
      guard activeSessionID == sessionID else { return .none }
      let outsidePhysicalBounds =
        metrics.offset < -0.5
        || metrics.offset > metrics.maximumOffset + 0.5
      return outsidePhysicalBounds || abs(metrics.offset - metrics.maximumOffset) > 0.5
        ? .scrollToBottom
        : .none
    }

    let retainedOffset = min(max(state.offset, 0), metrics.maximumOffset)
    state.offset = retainedOffset
    sessions[sessionID] = state
    guard activeSessionID == sessionID,
      abs(metrics.offset - retainedOffset) > 0.5
    else { return .none }
    return .scrollTo(offset: retainedOffset)
  }

  /// Observe content resizing, including a stable message id becoming taller.
  /// Following sessions request the new bottom; anchored sessions do not move.
  public mutating func contentDidResize(
    sessionID: String,
    metrics: ArkChatScrollMetrics
  ) -> ArkChatScrollCommand {
    var state = sessions[sessionID] ?? SessionState()
    state.contentHeight = metrics.contentHeight
    if state.followsBottom {
      state.offset = metrics.clampedOffset
      sessions[sessionID] = state
      // Compare the physical origin, not its clamped projection. After a large
      // final-message reflow AppKit can temporarily retain an origin beyond the
      // new maximum; clamping makes that overscroll look exactly at-bottom and
      // would preserve a blank viewport below real content forever.
      let outsidePhysicalBounds =
        metrics.offset < -0.5
        || metrics.offset > metrics.maximumOffset + 0.5
      return activeSessionID == sessionID
        && (outsidePhysicalBounds || metrics.distanceFromBottom > followThreshold)
        ? .scrollToBottom
        : .none
    }
    state.offset = metrics.clampedOffset
    if metrics.distanceFromBottom <= followThreshold {
      state.followsBottom = true
      state.offset = metrics.maximumOffset
      sessions[sessionID] = state
      return activeSessionID == sessionID ? .scrollToBottom : .none
    }
    sessions[sessionID] = state
    return .none
  }

  /// Explicitly return a session to the live-following mode.
  public mutating func requestBottom(
    sessionID: String,
    metrics: ArkChatScrollMetrics
  ) -> ArkChatScrollCommand {
    var state = sessions[sessionID] ?? SessionState()
    state.followsBottom = true
    state.offset = metrics.maximumOffset
    state.contentHeight = metrics.contentHeight
    sessions[sessionID] = state
    return activeSessionID == sessionID ? .scrollToBottom : .none
  }

  /// Capture the pixel anchor before older history is prepended.
  public mutating func capturePrependAnchor(
    sessionID: String,
    metrics: ArkChatScrollMetrics,
    visibleAnchor: ArkChatScrollContentAnchor? = nil
  ) -> ArkChatScrollPrependAnchor {
    var state = sessions[sessionID] ?? SessionState()
    state.offset = metrics.clampedOffset
    state.contentHeight = metrics.contentHeight
    state.prependGeneration &+= 1
    sessions[sessionID] = state
    return ArkChatScrollPrependAnchor(
      sessionID: sessionID,
      contentHeight: metrics.contentHeight,
      offset: metrics.clampedOffset,
      followedBottom: state.followsBottom,
      userRevision: state.userRevision,
      generation: state.prependGeneration,
      semanticID: visibleAnchor?.id,
      semanticViewportOffset: visibleAnchor.map { $0.documentOffset - metrics.clampedOffset }
    )
  }

  /// Restore the same visible content after prepend by adding the inserted
  /// height to the old top-normalized offset. A later user move or newer
  /// prepend invalidates the token so asynchronous history cannot grab scroll.
  public mutating func completePrepend(
    _ anchor: ArkChatScrollPrependAnchor,
    metrics: ArkChatScrollMetrics,
    resolvedAnchor: ArkChatScrollContentAnchor? = nil
  ) -> ArkChatScrollCommand {
    guard var state = sessions[anchor.sessionID],
      state.userRevision == anchor.userRevision,
      state.prependGeneration == anchor.generation
    else { return .none }

    state.contentHeight = metrics.contentHeight
    if anchor.followedBottom {
      state.followsBottom = true
      state.offset = metrics.maximumOffset
      sessions[anchor.sessionID] = state
      return activeSessionID == anchor.sessionID ? .scrollToBottom : .none
    }

    let semanticTarget: Double? = {
      guard let semanticID = anchor.semanticID,
        let viewportOffset = anchor.semanticViewportOffset,
        let resolvedAnchor,
        resolvedAnchor.id == semanticID
      else { return nil }
      return resolvedAnchor.documentOffset - viewportOffset
    }()
    let insertedHeight = metrics.contentHeight - anchor.contentHeight
    let target = min(
      max(semanticTarget ?? anchor.offset + insertedHeight, 0),
      metrics.maximumOffset
    )
    state.offset = target
    state.followsBottom = metrics.maximumOffset - target <= followThreshold
    sessions[anchor.sessionID] = state
    return activeSessionID == anchor.sessionID ? .scrollTo(offset: target) : .none
  }

  public func snapshot(for sessionID: String) -> ArkChatScrollSessionSnapshot? {
    sessions[sessionID].map {
      ArkChatScrollSessionSnapshot(
        followsBottom: $0.followsBottom,
        offset: $0.offset,
        contentHeight: $0.contentHeight
      )
    }
  }

  public mutating func removeSession(_ sessionID: String) {
    sessions.removeValue(forKey: sessionID)
    if activeSessionID == sessionID { activeSessionID = nil }
  }
}

/// Main-actor adapter between ``ArkChatScrollStateMachine`` and one AppKit
/// `NSScrollView`. It observes user clip movement; transcript projection changes
/// explicitly report content revisions after SwiftUI commits layout. AppKit
/// frame notifications are deliberately not an input because frame→scroll→frame
/// formed a self-sustaining layout loop under live transcripts.
@MainActor
public final class ArkChatScrollCoordinator {
  public private(set) var stateMachine: ArkChatScrollStateMachine
  public var onFollowingBottomChange: (@MainActor (Bool) -> Void)? {
    didSet { reportFollowingState() }
  }

  private weak var scrollView: NSScrollView?
  private var clipObserver: NSObjectProtocol?
  private var liveScrollObservers: [NSObjectProtocol] = []
  private var scrollWheelMonitor: Any?
  private var priorClipPostsBoundsChanges = false
  private var applyingCommand = false
  private var transitioning = false
  private var pendingSessionID: String?
  private var invalidated = false
  private var liveUserScroll = false
  private var scrollbarGestureActive = false
  private var userScrollIntentDeadline = 0.0
  /// Last document/viewport size handled by a semantic transcript revision.
  /// Repeated revisions whose final geometry is unchanged never ask AppKit to
  /// scroll again.
  private var lastHandledContentHeight: Double?
  private var lastHandledViewportHeight: Double?
  /// A newly attached scroll view may receive a retained machine whose active
  /// id belongs to the prior view. Do not let this view's initial origin
  /// overwrite that retained position before its first restoration.
  private var hasActivatedCurrentDocument = false

  public convenience init(scrollView: NSScrollView, followThreshold: Double = 24) {
    self.init(
      scrollView: scrollView,
      stateMachine: ArkChatScrollStateMachine(followThreshold: followThreshold)
    )
  }

  public init(
    scrollView: NSScrollView,
    stateMachine: ArkChatScrollStateMachine
  ) {
    self.scrollView = scrollView
    self.stateMachine = stateMachine
    installClipObserver(scrollView.contentView)
    installScrollWheelMonitor()
  }

  deinit {
    if let clipObserver { NotificationCenter.default.removeObserver(clipObserver) }
    for observer in liveScrollObservers { NotificationCenter.default.removeObserver(observer) }
    if let scrollWheelMonitor { NSEvent.removeMonitor(scrollWheelMonitor) }
  }

  public var activeSessionID: String? { stateMachine.activeSessionID }
  public var followsBottom: Bool {
    guard let activeSessionID else { return true }
    return stateMachine.snapshot(for: activeSessionID)?.followsBottom ?? true
  }

  /// Convenience for initial activation or a synchronous document swap.
  public func activate(sessionID: String) {
    beginSessionTransition(to: sessionID)
    completeSessionTransition()
  }

  /// Save the outgoing session and suppress geometry notifications while the
  /// main view replaces its transcript document.
  public func beginSessionTransition(to sessionID: String) {
    guard !invalidated else { return }
    if hasActivatedCurrentDocument,
      let current = stateMachine.activeSessionID,
      let metrics = currentMetrics()
    {
      stateMachine.viewportDidMove(
        sessionID: current,
        metrics: metrics,
        source: .programmatic
      )
    }
    transitioning = true
    pendingSessionID = sessionID
  }

  /// Restore the incoming session after its document view has its final size.
  public func completeSessionTransition() {
    guard !invalidated, let sessionID = pendingSessionID else { return }
    pendingSessionID = nil
    let metrics =
      currentMetrics()
      ?? ArkChatScrollMetrics(
        contentHeight: 0,
        viewportHeight: 0,
        offset: 0
      )
    let command = stateMachine.activate(sessionID: sessionID, metrics: metrics)
    rememberGeometry(metrics)
    apply(command)
    hasActivatedCurrentDocument = true
    transitioning = false
    reportFollowingState()
  }

  /// Explicit hook for a representable whose document view or intrinsic
  /// content height changed. Stable row/message identifiers are irrelevant.
  public func contentDidChange() {
    guard !invalidated, !transitioning,
      let sessionID = stateMachine.activeSessionID
    else { return }
    guard let metrics = currentMetrics() else { return }
    guard geometryChanged(metrics) else {
      reportFollowingState()
      return
    }
    rememberGeometry(metrics)
    apply(stateMachine.contentDidResize(sessionID: sessionID, metrics: metrics))
    reportFollowingState()
  }

  public func capturePrependAnchor(
    visibleAnchor: ArkChatScrollContentAnchor? = nil
  ) -> ArkChatScrollPrependAnchor? {
    guard !invalidated, !transitioning,
      let sessionID = stateMachine.activeSessionID,
      let metrics = currentMetrics()
    else { return nil }
    return stateMachine.capturePrependAnchor(
      sessionID: sessionID,
      metrics: metrics,
      visibleAnchor: visibleAnchor
    )
  }

  public func restoreAfterPrepend(
    _ anchor: ArkChatScrollPrependAnchor,
    resolvedAnchor: ArkChatScrollContentAnchor? = nil
  ) {
    guard !invalidated, !transitioning, let metrics = currentMetrics() else { return }
    apply(
      stateMachine.completePrepend(
        anchor,
        metrics: metrics,
        resolvedAnchor: resolvedAnchor
      ))
    reportFollowingState()
  }

  public func scrollToBottom() {
    guard !invalidated, !transitioning,
      let sessionID = stateMachine.activeSessionID,
      let metrics = currentMetrics()
    else { return }
    apply(stateMachine.requestBottom(sessionID: sessionID, metrics: metrics))
    reportFollowingState()
  }

  /// Current top-normalized AppKit geometry, useful to a bridge and tests.
  public func currentMetrics() -> ArkChatScrollMetrics? {
    guard let scrollView, let document = scrollView.documentView else { return nil }
    let visible = scrollView.documentVisibleRect
    let bounds = document.bounds
    let contentHeight = max(Double(bounds.height), 0)
    let viewportHeight = max(Double(visible.height), 0)
    let rawOffset =
      document.isFlipped
      ? Double(visible.minY - bounds.minY)
      : Double(bounds.maxY - visible.maxY)
    return ArkChatScrollMetrics(
      contentHeight: contentHeight,
      viewportHeight: viewportHeight,
      offset: rawOffset
    )
  }

  public func snapshot(for sessionID: String) -> ArkChatScrollSessionSnapshot? {
    stateMachine.snapshot(for: sessionID)
  }

  public func removeSession(_ sessionID: String) {
    stateMachine.removeSession(sessionID)
    reportFollowingState()
  }

  /// Release notifications before the owning representable tears down.
  public func invalidate() {
    guard !invalidated else { return }
    invalidated = true
    if let clipObserver {
      NotificationCenter.default.removeObserver(clipObserver)
      self.clipObserver = nil
    }
    for observer in liveScrollObservers { NotificationCenter.default.removeObserver(observer) }
    liveScrollObservers.removeAll()
    if let scrollWheelMonitor {
      NSEvent.removeMonitor(scrollWheelMonitor)
      self.scrollWheelMonitor = nil
    }
    if let clip = scrollView?.contentView {
      clip.postsBoundsChangedNotifications = priorClipPostsBoundsChanges
    }
  }

  private func installClipObserver(_ clip: NSClipView) {
    priorClipPostsBoundsChanges = clip.postsBoundsChangedNotifications
    clip.postsBoundsChangedNotifications = true
    clipObserver = NotificationCenter.default.addObserver(
      forName: NSView.boundsDidChangeNotification,
      object: clip,
      queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.clipBoundsDidChange() }
    }
  }

  private func installScrollWheelMonitor() {
    scrollWheelMonitor = NSEvent.addLocalMonitorForEvents(
      matching: [.scrollWheel, .leftMouseDown, .leftMouseDragged, .leftMouseUp, .keyDown]
    ) {
      [weak self] event in
      var routedEvent: NSEvent? = event
      MainActor.assumeIsolated {
        if let self { routedEvent = self.routeUserInput(event) }
      }
      return routedEvent
    }

    let center = NotificationCenter.default
    liveScrollObservers = [
      center.addObserver(
        forName: NSScrollView.willStartLiveScrollNotification,
        object: scrollView,
        queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated {
          self?.liveUserScroll = true
          self?.noteUserScrollInput()
        }
      },
      center.addObserver(
        forName: NSScrollView.didLiveScrollNotification,
        object: scrollView,
        queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated { self?.noteUserScrollInput() }
      },
      center.addObserver(
        forName: NSScrollView.didEndLiveScrollNotification,
        object: scrollView,
        queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated {
          self?.noteUserScrollInput()
          self?.liveUserScroll = false
        }
      },
    ]
  }

  private func routeUserInput(_ event: NSEvent) -> NSEvent? {
    switch event.type {
    case .scrollWheel:
      return routeNestedScrollWheel(event)
    case .leftMouseDown:
      scrollbarGestureActive = hitsTranscriptScroller(event)
      if scrollbarGestureActive { noteUserScrollInput() }
    case .leftMouseDragged:
      if scrollbarGestureActive { noteUserScrollInput() }
    case .leftMouseUp:
      if scrollbarGestureActive { noteUserScrollInput() }
      scrollbarGestureActive = false
    case .keyDown:
      if isTranscriptScrollKey(event) { noteUserScrollInput() }
    default:
      break
    }
    return event
  }

  private func routeNestedScrollWheel(_ event: NSEvent) -> NSEvent? {
    guard !invalidated,
      let scrollView,
      let window = scrollView.window,
      event.window === window,
      let contentView = window.contentView
    else { return event }

    let point = contentView.convert(event.locationInWindow, from: nil)
    guard let hitView = contentView.hitTest(point), hitView.isDescendant(of: scrollView)
    else { return event }

    guard let nested = nestedScrollView(containing: hitView, before: scrollView) else {
      noteUserScrollInput()
      return event
    }

    let horizontalRange = Double(
      max(
        (nested.documentView?.bounds.width ?? 0) - nested.documentVisibleRect.width,
        0
      ))
    let verticalRange = Double(
      max(
        (nested.documentView?.bounds.height ?? 0) - nested.documentVisibleRect.height,
        0
      ))
    guard
      ArkChatNestedScrollRouting.forwardsToTranscript(
        deltaX: Double(event.scrollingDeltaX),
        deltaY: Double(event.scrollingDeltaY),
        horizontalRange: horizontalRange,
        verticalRange: verticalRange
      )
    else { return event }

    noteUserScrollInput()
    scrollView.scrollWheel(with: event)
    return nil
  }

  private func hitsTranscriptScroller(_ event: NSEvent) -> Bool {
    guard !invalidated,
      let scrollView,
      let window = scrollView.window,
      event.window === window
    else { return false }
    let point = scrollView.convert(event.locationInWindow, from: nil)
    return [scrollView.verticalScroller, scrollView.horizontalScroller]
      .compactMap { $0 }
      .contains { !$0.isHidden && $0.frame.contains(point) }
  }

  private func isTranscriptScrollKey(_ event: NSEvent) -> Bool {
    guard !invalidated,
      let scrollView,
      let window = scrollView.window,
      event.window === window,
      let responderView = window.firstResponder as? NSView,
      responderView === scrollView || responderView.isDescendant(of: scrollView)
    else { return false }
    // Home, Page Up, End, Page Down, arrows and Space are the AppKit keys that
    // can move a focused read-only transcript.
    return [49, 115, 116, 119, 121, 123, 124, 125, 126].contains(event.keyCode)
  }

  /// Arm the next offset-only clip notification as genuine user movement.
  /// The short lease covers momentum callbacks without letting a later
  /// geometry resize inherit user intent; size changes are classified first.
  func noteUserScrollInput() {
    userScrollIntentDeadline = max(
      userScrollIntentDeadline,
      ProcessInfo.processInfo.systemUptime + 0.35
    )
  }

  private func nestedScrollView(
    containing hitView: NSView,
    before transcript: NSScrollView
  ) -> NSScrollView? {
    var candidate: NSView? = hitView
    while let view = candidate, view !== transcript {
      if let nested = view as? NSScrollView { return nested }
      candidate = view.superview
    }
    return nil
  }

  private func clipBoundsDidChange() {
    guard !invalidated, !transitioning, !applyingCommand,
      let sessionID = stateMachine.activeSessionID,
      let metrics = currentMetrics()
    else { return }
    let resized = geometryChanged(metrics)
    rememberGeometry(metrics)
    if resized {
      apply(stateMachine.viewportDidResize(sessionID: sessionID, metrics: metrics))
    } else {
      let isUserMove =
        liveUserScroll
        || ProcessInfo.processInfo.systemUptime <= userScrollIntentDeadline
      stateMachine.viewportDidMove(
        sessionID: sessionID,
        metrics: metrics,
        source: isUserMove ? .user : .programmatic
      )
    }
    reportFollowingState()
  }

  private func apply(_ command: ArkChatScrollCommand) {
    guard command != .none,
      let scrollView,
      let document = scrollView.documentView,
      let sessionID = stateMachine.activeSessionID,
      let metrics = currentMetrics()
    else { return }

    let logicalOffset: Double
    switch command {
    case .none: return
    case .scrollToBottom: logicalOffset = metrics.maximumOffset
    case .scrollTo(let offset): logicalOffset = min(max(offset, 0), metrics.maximumOffset)
    }
    // A no-op `scroll(to:)` is not free: NSScrollView may invalidate the
    // hosting document even when its logical origin is unchanged. Record the
    // semantic position without asking AppKit to scroll again.
    // A raw out-of-range origin must be corrected even when its clamped value
    // equals the desired endpoint. Otherwise post-reflow bottom overscroll is
    // misclassified as a no-op.
    if abs(metrics.offset - logicalOffset) <= 0.5 {
      stateMachine.viewportDidMove(
        sessionID: sessionID,
        metrics: metrics,
        source: .programmatic
      )
      return
    }
    let bounds = document.bounds
    let visibleHeight = CGFloat(metrics.viewportHeight)
    let targetY =
      document.isFlipped
      ? bounds.minY + CGFloat(logicalOffset)
      : bounds.maxY - visibleHeight - CGFloat(logicalOffset)

    applyingCommand = true
    scrollView.contentView.scroll(
      to: NSPoint(
        x: scrollView.contentView.bounds.origin.x,
        y: targetY
      ))
    scrollView.reflectScrolledClipView(scrollView.contentView)
    applyingCommand = false

    if let applied = currentMetrics() {
      stateMachine.viewportDidMove(
        sessionID: sessionID,
        metrics: applied,
        source: .programmatic
      )
    }
  }

  private func reportFollowingState() {
    onFollowingBottomChange?(followsBottom)
  }

  private func geometryChanged(_ metrics: ArkChatScrollMetrics) -> Bool {
    guard let lastHandledContentHeight, let lastHandledViewportHeight else { return true }
    return abs(lastHandledContentHeight - metrics.contentHeight) > 0.5
      || abs(lastHandledViewportHeight - metrics.viewportHeight) > 0.5
  }

  private func rememberGeometry(_ metrics: ArkChatScrollMetrics) {
    lastHandledContentHeight = metrics.contentHeight
    lastHandledViewportHeight = metrics.viewportHeight
  }
}
