import AppKit
import QuartzCore
import SwiftUI

/// Shared visibility and Reduce Motion gate for native views with perpetual
/// Core Animation effects. The owning view reports window changes; the gate
/// observes later window/application visibility and accessibility changes.
@MainActor
final class NativeContinuousAnimationGate: NSObject {
  private weak var view: NSView?
  private let onChange: @MainActor () -> Void

  init(view: NSView, onChange: @escaping @MainActor () -> Void) {
    self.view = view
    self.onChange = onChange
  }

  var allowsMotion: Bool {
    guard let view else { return false }
    return Self.permitsContinuousMotion(
      windowAttached: view.window != nil,
      windowVisible: view.window?.isVisible == true,
      windowMiniaturized: view.window?.isMiniaturized == true,
      windowOccluded: view.window?.occlusionState.contains(.visible) != true,
      applicationHidden: NSApp?.isHidden == true,
      viewHidden: view.isHiddenOrHasHiddenAncestor,
      reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    )
  }

  nonisolated static func permitsContinuousMotion(
    windowAttached: Bool,
    windowVisible: Bool,
    windowMiniaturized: Bool,
    windowOccluded: Bool,
    applicationHidden: Bool,
    viewHidden: Bool,
    reduceMotion: Bool
  ) -> Bool {
    windowAttached
      && windowVisible
      && !windowMiniaturized
      && !windowOccluded
      && !applicationHidden
      && !viewHidden
      && !reduceMotion
  }

  func windowDidChange() {
    stopObserving()
    guard let window = view?.window else {
      onChange()
      return
    }
    for name in [
      NSWindow.didMiniaturizeNotification,
      NSWindow.didDeminiaturizeNotification,
      NSWindow.didChangeOcclusionStateNotification,
    ] {
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(observedVisibilityDidChange(_:)),
        name: name,
        object: window
      )
    }
    for name in [NSApplication.didHideNotification, NSApplication.didUnhideNotification] {
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(observedVisibilityDidChange(_:)),
        name: name,
        object: nil
      )
    }
    NSWorkspace.shared.notificationCenter.addObserver(
      self,
      selector: #selector(observedVisibilityDidChange(_:)),
      name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
      object: nil
    )
    onChange()
  }

  func invalidate() {
    stopObserving()
    view = nil
  }

  @objc private func observedVisibilityDidChange(_ notification: Notification) {
    onChange()
  }

  private func stopObserving() {
    NotificationCenter.default.removeObserver(self)
    NSWorkspace.shared.notificationCenter.removeObserver(self)
  }
}

struct NativeWikiPulseNode: Equatable {
  let id: String
  let point: CGPoint
  let diameter: CGFloat
  let color: NSColor
  let intensity: CGFloat
  let seed: UInt64
}

/// One AppKit view owns GPU-composited glow layers for the whole graph. Node
/// positions never tick: Core Animation changes only opacity and transform.
struct NativeWikiPulseOverlay: NSViewRepresentable {
  let nodes: [NativeWikiPulseNode]

  func makeNSView(context: Context) -> NativeWikiPulseLayerView {
    let view = NativeWikiPulseLayerView()
    view.update(nodes)
    return view
  }

  func updateNSView(_ view: NativeWikiPulseLayerView, context: Context) {
    view.update(nodes)
  }

  static func dismantleNSView(
    _ view: NativeWikiPulseLayerView,
    coordinator: Void
  ) {
    view.dismantle()
  }
}

final class NativeWikiPulseLayerView: NSView {
  private var layersByID: [String: CAShapeLayer] = [:]
  private var seedsByID: [String: UInt64] = [:]
  private lazy var animationGate = NativeContinuousAnimationGate(view: self) { [weak self] in
    self?.updateAnimationState()
  }
  override var isFlipped: Bool { true }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = false
  }

  required init?(coder: NSCoder) {
    fatalError("NativeWikiPulseLayerView is programmatic")
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    animationGate.windowDidChange()
  }

  func update(_ nodes: [NativeWikiPulseNode]) {
    let liveIDs = Set(nodes.map(\.id))
    let staleIDs = layersByID.keys.filter { !liveIDs.contains($0) }
    for id in staleIDs {
      layersByID.removeValue(forKey: id)?.removeFromSuperlayer()
      seedsByID.removeValue(forKey: id)
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for node in nodes {
      let glow = layersByID[node.id] ?? makeLayer(id: node.id)
      seedsByID[node.id] = node.seed
      let expanded = max(12, node.diameter * 1.7)
      glow.frame = CGRect(
        x: node.point.x - expanded / 2,
        y: node.point.y - expanded / 2,
        width: expanded,
        height: expanded
      )
      glow.path = CGPath(ellipseIn: glow.bounds.insetBy(dx: expanded * 0.18, dy: expanded * 0.18), transform: nil)
      glow.fillColor = node.color.withAlphaComponent(0.035 * node.intensity).cgColor
      glow.shadowColor = node.color.cgColor
      glow.shadowOpacity = Float(0.52 * node.intensity)
      glow.shadowRadius = 12 * node.intensity
      glow.opacity = Float(0.48 * node.intensity)
    }
    CATransaction.commit()
    updateAnimationState()
  }

  func dismantle() {
    animationGate.invalidate()
    stopAllAnimations()
  }

  private func makeLayer(id: String) -> CAShapeLayer {
    let glow = CAShapeLayer()
    glow.actions = [
      "position": NSNull(), "bounds": NSNull(), "path": NSNull(),
      "fillColor": NSNull(), "shadowColor": NSNull(), "opacity": NSNull(),
    ]
    layer?.addSublayer(glow)
    layersByID[id] = glow
    return glow
  }

  private func updateAnimationState() {
    guard animationGate.allowsMotion else {
      stopAllAnimations()
      return
    }
    for (id, glow) in layersByID {
      guard glow.animation(forKey: "ark.wiki.pulse.opacity") == nil,
            let seed = seedsByID[id]
      else { continue }
      installAnimations(on: glow, seed: seed)
    }
  }

  private func installAnimations(on glow: CAShapeLayer, seed: UInt64) {
    let opacity = CABasicAnimation(keyPath: "opacity")
    opacity.fromValue = 0.30
    opacity.toValue = 0.58
    opacity.duration = 3.2 + Double(seed % 17) / 10
    opacity.autoreverses = true
    opacity.repeatCount = .infinity
    opacity.beginTime = CACurrentMediaTime() + Double(seed % 23) / 20
    opacity.isRemovedOnCompletion = false
    glow.add(opacity, forKey: "ark.wiki.pulse.opacity")

    let scale = CABasicAnimation(keyPath: "transform.scale")
    scale.fromValue = 0.96
    scale.toValue = 1.06
    scale.duration = opacity.duration
    scale.autoreverses = true
    scale.repeatCount = .infinity
    scale.beginTime = opacity.beginTime
    scale.isRemovedOnCompletion = false
    glow.add(scale, forKey: "ark.wiki.pulse.scale")
  }

  private func stopAllAnimations() {
    for glow in layersByID.values { glow.removeAllAnimations() }
  }
}

struct NativeWikiInteractionNode: Equatable {
  let id: String
  let point: CGPoint
  let hitRadius: CGFloat
}

@MainActor
final class NativeWikiViewportController: ObservableObject {
  @Published private(set) var viewport = ArkWikiGraphViewport()

  func translate(x: Double, y: Double) {
    var next = viewport
    next.translate(x: x, y: y)
    guard next != viewport else { return }
    viewport = next
  }

  func magnify(by multiplier: Double) {
    var next = viewport
    next.magnify(by: multiplier)
    guard next != viewport else { return }
    viewport = next
  }

  func reset() {
    let next = ArkWikiGraphViewport()
    guard next != viewport else { return }
    viewport = next
  }
}

struct NativeWikiViewportTransform<Content: View>: View {
  @ObservedObject var controller: NativeWikiViewportController
  let content: Content

  init(
    controller: NativeWikiViewportController,
    @ViewBuilder content: () -> Content
  ) {
    self.controller = controller
    self.content = content()
  }

  var body: some View {
    content
      .scaleEffect(CGFloat(controller.viewport.zoom))
      .offset(
        x: CGFloat(controller.viewport.panX),
        y: CGFloat(controller.viewport.panY)
      )
  }
}

struct NativeWikiInteractionHint: View {
  @ObservedObject var controller: NativeWikiViewportController
  let language: ArkLanguagePreference

  var body: some View {
    let percent = Int((controller.viewport.zoom * 100).rounded())
    Text(ArkL10n.format(
      .wikiInteractionHint,
      language,
      arguments: [String(percent)]
    ))
      .font(.system(size: 10, weight: .medium))
      .foregroundStyle(Color.white.opacity(0.64))
  }
}

/// One AppKit host owns both the SwiftUI graph and its physical interaction.
/// This avoids relying on z-order between a SwiftUI DisplayList and a sibling
/// representable: the canvas parent is the responder, while the top toolbar is
/// explicitly handed through to its child NSHostingView.
struct NativeWikiInteractionHost<Content: View>: NSViewRepresentable {
  let content: Content
  let contentRevision: Int
  let nodes: [NativeWikiInteractionNode]
  let viewportController: NativeWikiViewportController
  let onSelect: (String) -> Void
  let onClear: () -> Void

  init(
    contentRevision: Int,
    nodes: [NativeWikiInteractionNode],
    viewportController: NativeWikiViewportController,
    onSelect: @escaping (String) -> Void,
    onClear: @escaping () -> Void,
    @ViewBuilder content: () -> Content
  ) {
    self.content = content()
    self.contentRevision = contentRevision
    self.nodes = nodes
    self.viewportController = viewportController
    self.onSelect = onSelect
    self.onClear = onClear
  }

  func makeNSView(context: Context) -> NativeWikiInteractionHostView<Content> {
    let view = NativeWikiInteractionHostView(rootView: content)
    view.viewportController = viewportController
    view.nodes = nodes
    view.contentRevision = contentRevision
    view.onSelect = onSelect
    view.onClear = onClear
    return view
  }

  func updateNSView(_ view: NativeWikiInteractionHostView<Content>, context: Context) {
    view.viewportController = viewportController
    if view.contentRevision != contentRevision {
      view.rootView = content
      view.contentRevision = contentRevision
    }
    view.nodes = nodes
    view.onSelect = onSelect
    view.onClear = onClear
  }

  static func dismantleNSView(
    _ view: NativeWikiInteractionHostView<Content>,
    coordinator: Void
  ) {
    view.resetInteraction()
  }
}

/// The hosting view itself is the canvas responder.  A separate parent view is
/// not sufficient here: AppKit can resolve the inner NSHostingView as the
/// scroll/magnification target before the parent ever receives the event.
/// Owning the responder at this exact layer keeps physical mouse, wheel and
/// trackpad events on the same object that presents the SwiftUI graph.
final class NativeWikiInteractionHostView<Content: View>: NSHostingView<Content> {
  var viewportController: NativeWikiViewportController!
  var contentRevision = 0
  var nodes: [NativeWikiInteractionNode] = []
  var onSelect: ((String) -> Void)?
  var onClear: (() -> Void)?
  private var mouseDownPoint: NSPoint?
  private var lastDragPoint: NSPoint?
  private var pressedNodeID: String?
  private var didDrag = false
  private var pendingPan = CGSize.zero
  private var pendingLogDelta = 0.0
  private var deliveryScheduled = false
  override var acceptsFirstResponder: Bool { true }
  override var mouseDownCanMoveWindow: Bool { false }

  required init(rootView: Content) {
    super.init(rootView: rootView)
    isFlipped = true
    wantsLayer = true
    layer?.masksToBounds = true
  }

  required init?(coder: NSCoder) {
    fatalError("NativeWikiInteractionHostView is programmatic")
  }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func hitTest(_ point: NSPoint) -> NSView? {
    guard bounds.contains(point) else { return nil }
    if point.y <= 72 {
      return nil
    }
    return self
  }

  override func resetCursorRects() {
    let canvasRect = NSRect(
      x: bounds.minX,
      y: min(bounds.maxY, 72),
      width: bounds.width,
      height: max(0, bounds.height - 72)
    )
    addCursorRect(canvasRect, cursor: didDrag ? .closedHand : .openHand)
  }

  override func mouseDown(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    guard point.y > 72 else {
      super.mouseDown(with: event)
      return
    }
    mouseDownPoint = point
    lastDragPoint = point
    pressedNodeID = node(at: point)?.id
    didDrag = false
    window?.makeFirstResponder(self)
  }

  override func mouseDragged(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    guard let origin = mouseDownPoint, let previous = lastDragPoint else { return }
    if !didDrag, hypot(point.x - origin.x, point.y - origin.y) >= 3 {
      didDrag = true
      window?.invalidateCursorRects(for: self)
    }
    if didDrag {
      pendingPan.width += point.x - previous.x
      pendingPan.height += point.y - previous.y
      scheduleDelivery()
    }
    lastDragPoint = point
  }

  override func mouseUp(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    if !didDrag {
      if let id = pressedNodeID ?? node(at: point)?.id { onSelect?(id) }
      else { onClear?() }
    }
    mouseDownPoint = nil
    lastDragPoint = nil
    pressedNodeID = nil
    didDrag = false
    window?.invalidateCursorRects(for: self)
  }

  override func scrollWheel(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    guard point.y > 72 else {
      super.scrollWheel(with: event)
      return
    }
    let gain = event.hasPreciseScrollingDeltas ? 0.0045 : 0.042
    let delta = min(12, max(-12, Double(event.scrollingDeltaY)))
    pendingLogDelta = min(0.18, max(-0.18, pendingLogDelta + delta * gain))
    scheduleDelivery()
  }

  override func magnify(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    guard point.y > 72 else {
      super.magnify(with: event)
      return
    }
    let multiplier = max(0.25, 1 + Double(event.magnification))
    pendingLogDelta = min(0.32, max(-0.32, pendingLogDelta + log(multiplier)))
    scheduleDelivery()
  }

  private func scheduleDelivery() {
    guard !deliveryScheduled else { return }
    deliveryScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let pan = self.pendingPan
      let multiplier = exp(self.pendingLogDelta)
      self.pendingPan = .zero
      self.pendingLogDelta = 0
      self.deliveryScheduled = false
      if pan != .zero {
        self.viewportController.translate(x: Double(pan.width), y: Double(pan.height))
      }
      if abs(multiplier - 1) > 0.0001 {
        self.viewportController.magnify(by: multiplier)
      }
    }
  }

  private func node(at point: NSPoint) -> NativeWikiInteractionNode? {
    let viewport = viewportController.viewport
    let center = CGPoint(x: bounds.midX, y: bounds.midY)
    func visiblePoint(_ node: NativeWikiInteractionNode) -> CGPoint {
      CGPoint(
        x: center.x + (node.point.x - center.x) * CGFloat(viewport.zoom)
          + CGFloat(viewport.panX),
        y: center.y + (node.point.y - center.y) * CGFloat(viewport.zoom)
          + CGFloat(viewport.panY)
      )
    }
    return nodes.min { left, right in
      let leftPoint = visiblePoint(left)
      let rightPoint = visiblePoint(right)
      return hypot(leftPoint.x - point.x, leftPoint.y - point.y)
        < hypot(rightPoint.x - point.x, rightPoint.y - point.y)
    }.flatMap { candidate in
      let candidatePoint = visiblePoint(candidate)
      return hypot(candidatePoint.x - point.x, candidatePoint.y - point.y)
        <= max(20, candidate.hitRadius * CGFloat(viewport.zoom))
        ? candidate : nil
    }
  }

  func resetInteraction() {
    mouseDownPoint = nil
    lastDragPoint = nil
    pressedNodeID = nil
    didDrag = false
    pendingPan = .zero
    pendingLogDelta = 0
    deliveryScheduled = false
  }
}

struct NativeWikiThoughtConnection {
  let id: String
  let start: CGPoint
  let control1: CGPoint
  let control2: CGPoint
  let end: CGPoint
  let color: NSColor
}

/// GPU-composited particles flowing along selected semantic relations only
/// while the authoritative session state says the agent is running. The path
/// geometry is fixed; no SwiftUI timeline or node-position tick is involved.
struct NativeWikiThoughtFlowOverlay: NSViewRepresentable {
  let connections: [NativeWikiThoughtConnection]
  let isThinking: Bool

  func makeNSView(context: Context) -> NativeWikiThoughtFlowLayerView {
    let view = NativeWikiThoughtFlowLayerView()
    view.update(connections: connections, isThinking: isThinking)
    return view
  }

  func updateNSView(_ view: NativeWikiThoughtFlowLayerView, context: Context) {
    view.update(connections: connections, isThinking: isThinking)
  }

  static func dismantleNSView(
    _ view: NativeWikiThoughtFlowLayerView,
    coordinator: Void
  ) {
    view.dismantle()
  }
}

final class NativeWikiThoughtFlowLayerView: NSView {
  private var layersByID: [String: CAShapeLayer] = [:]
  private var isThinking = false
  private lazy var animationGate = NativeContinuousAnimationGate(view: self) { [weak self] in
    self?.updateAnimationState()
  }
  override var isFlipped: Bool { true }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    wantsLayer = true
    layer?.masksToBounds = false
  }

  required init?(coder: NSCoder) {
    fatalError("NativeWikiThoughtFlowLayerView is programmatic")
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    animationGate.windowDidChange()
  }

  func update(connections: [NativeWikiThoughtConnection], isThinking: Bool) {
    self.isThinking = isThinking
    let liveIDs = Set(connections.map(\.id))
    for id in layersByID.keys.filter({ !liveIDs.contains($0) }) {
      layersByID.removeValue(forKey: id)?.removeFromSuperlayer()
    }

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for connection in connections {
      let flow = layersByID[connection.id] ?? makeLayer(id: connection.id)
      let path = CGMutablePath()
      path.move(to: connection.start)
      path.addCurve(
        to: connection.end,
        control1: connection.control1,
        control2: connection.control2
      )
      flow.path = path
      flow.strokeColor = connection.color.withAlphaComponent(0.86).cgColor
    }
    CATransaction.commit()
    updateAnimationState()
  }

  func dismantle() {
    animationGate.invalidate()
    removeAllAnimations()
  }

  private func makeLayer(id: String) -> CAShapeLayer {
    let flow = CAShapeLayer()
    flow.fillColor = nil
    flow.lineWidth = 1.25
    flow.lineCap = .round
    flow.lineDashPattern = [1.2, 8.5]
    flow.actions = [
      "path": NSNull(), "strokeColor": NSNull(), "opacity": NSNull(),
      "lineDashPhase": NSNull(),
    ]
    layer?.addSublayer(flow)
    layersByID[id] = flow
    return flow
  }

  private func installThinkingAnimations(on flow: CAShapeLayer, id: String) {
    guard flow.animation(forKey: "ark.wiki.thought-flow") == nil else { return }
    let seed = ArkWikiGraphLayout.stableSeed(for: id)
    let phase = CABasicAnimation(keyPath: "lineDashPhase")
    phase.fromValue = 0
    phase.toValue = -19.4
    phase.duration = 4.1 + Double(seed % 13) / 10
    phase.repeatCount = .infinity
    phase.beginTime = CACurrentMediaTime() + Double(seed % 17) / 12
    phase.isRemovedOnCompletion = false
    flow.add(phase, forKey: "ark.wiki.thought-flow")

    let breath = CABasicAnimation(keyPath: "opacity")
    breath.fromValue = 0.22
    breath.toValue = 0.58
    breath.duration = 3.6 + Double(seed % 11) / 10
    breath.autoreverses = true
    breath.repeatCount = .infinity
    breath.beginTime = phase.beginTime
    breath.isRemovedOnCompletion = false
    flow.add(breath, forKey: "ark.wiki.thought-breath")
  }

  private func updateAnimationState() {
    let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    let animate = isThinking && animationGate.allowsMotion
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    for (id, flow) in layersByID {
      flow.opacity = isThinking ? (reduceMotion ? 0.28 : 0.52) : 0
      if animate {
        installThinkingAnimations(on: flow, id: id)
      } else {
        flow.removeAllAnimations()
      }
    }
    CATransaction.commit()
  }

  func removeAllAnimations() {
    for flow in layersByID.values { flow.removeAllAnimations() }
  }
}
