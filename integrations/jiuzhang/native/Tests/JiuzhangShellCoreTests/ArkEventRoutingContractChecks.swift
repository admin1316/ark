import Foundation
@testable import JiuzhangShellUI

private func runContinuousAnimationPolicyChecks() {
  func permits(
    attached: Bool = true,
    visible: Bool = true,
    miniaturized: Bool = false,
    occluded: Bool = false,
    applicationHidden: Bool = false,
    viewHidden: Bool = false,
    reduceMotion: Bool = false
  ) -> Bool {
    NativeContinuousAnimationGate.permitsContinuousMotion(
      windowAttached: attached,
      windowVisible: visible,
      windowMiniaturized: miniaturized,
      windowOccluded: occluded,
      applicationHidden: applicationHidden,
      viewHidden: viewHidden,
      reduceMotion: reduceMotion
    )
  }
  check(permits(), "native continuous animation runs only on a visible attached window")
  check(
    !permits(attached: false)
      && !permits(visible: false)
      && !permits(miniaturized: true)
      && !permits(occluded: true)
      && !permits(applicationHidden: true)
      && !permits(viewHidden: true)
      && !permits(reduceMotion: true),
    "native continuous animation stops for every hidden-window and Reduce Motion state"
  )
}

private func eventRoutingSlice(
  _ source: String,
  from start: String,
  through end: String
) -> String? {
  guard
    let startRange = source.range(of: start),
    let endRange = source.range(
      of: end,
      range: startRange.upperBound..<source.endIndex
    )
  else { return nil }
  return String(source[startRange.lowerBound..<endRange.upperBound])
}

func runArkEventRoutingContractChecks() {
  runContinuousAnimationPolicyChecks()
  let appDelegateURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShell/AppDelegate.swift"
  )
  let rootURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/ArkRootView.swift"
  )
  let workbenchURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeWorkbenchView.swift"
  )
  let wikiEffectsURL = contractNativeRoot.appendingPathComponent(
    "Sources/JiuzhangShellUI/NativeWikiGraphEffects.swift"
  )

  guard
    let appDelegate = try? String(contentsOf: appDelegateURL, encoding: .utf8),
    let root = try? String(contentsOf: rootURL, encoding: .utf8),
    let workbench = try? String(contentsOf: workbenchURL, encoding: .utf8),
    let wikiEffects = try? String(contentsOf: wikiEffectsURL, encoding: .utf8)
  else {
    check(false, "native event-routing sources are readable")
    return
  }

  let contentHost = eventRoutingSlice(
    appDelegate,
    from: "private final class ArkWindowContentView",
    through: "}"
  )
  check(
    contentHost?.contains("mouseDownCanMoveWindow: Bool { false }") == true
      && contentHost?.contains("Bool { true }") == false,
    "native content host never turns the entire SwiftUI tree into a window drag target"
  )
  check(
    appDelegate.contains("window.isMovableByWindowBackground = false")
      && appDelegate.contains("private final class ArkHostingView<Content: View>")
      && appDelegate.contains("override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }"),
    "native window leaves movement to explicit drag surfaces and edge controls accept the first click"
  )
  let dragSurface = eventRoutingSlice(
    root,
    from: "final class WindowDragSurfaceView",
    through: "private struct WorkbenchRootSelection"
  )
  let firstMouseButton = eventRoutingSlice(
    root,
    from: "struct NativeFirstMouseIconButton",
    through: "final class WindowDragSurfaceView"
  )
  check(
    !root.contains(".background(WindowDragSurface())")
      && dragSurface?.contains("mouseDownCanMoveWindow: Bool { true }") == true
      && dragSurface?.contains("override func hitTest(_ point: NSPoint) -> NSView?") == true
      && dragSurface?.contains("return self") == true
      && dragSurface?.contains("acceptsFirstMouse") == true
      && dragSurface?.contains("window.performDrag(with: event)") == true,
    "only dedicated header drag surfaces start window movement; no transparent full-window drag layer remains"
  )
  check(
    firstMouseButton?.contains("NativeFirstMouseNSButton") == true
      && firstMouseButton?.contains("override var mouseDownCanMoveWindow: Bool { false }") == true
      && firstMouseButton?.contains("override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }") == true
      && firstMouseButton?.contains("override func highlight") == false
      && firstMouseButton?.contains("button.setAccessibilityIdentifier(accessibilityIdentifier)") == true,
    "native edge toggles own first-mouse delivery and never start window dragging"
  )

  let sessionHeader = eventRoutingSlice(
    root,
    from: "private struct NativeSessionHeader",
    through: "private struct NativeSessionStatusLight"
  )
  check(
    sessionHeader?.contains("WindowDragSurface()") == true
      && sessionHeader?.contains(".frame(maxWidth: .infinity, minHeight: 28)") == true,
    "native session header reserves one explicit non-interactive window drag region"
  )

  let workbenchTabs = eventRoutingSlice(
    workbench,
    from: "private struct NativeWorkbenchTabBar",
    through: "struct NativeWorkbenchRootChooser"
  )
  check(
    workbenchTabs?.contains("WindowDragSurface()") == true
      && workbenchTabs?.contains(".frame(width: 36)") == true
      && workbenchTabs?.contains(".frame(maxHeight: .infinity)") == true
      && workbenchTabs?.contains(".frame(minWidth: 120)") == true
      && workbenchTabs?.contains(".layoutPriority(1)") == true
      && workbenchTabs?.contains("proxy.scrollTo(active, anchor: .leading)") == true
      && workbenchTabs?.contains(".onChange(of: model.toolTabs.tabs.count)") == true
      && workbenchTabs?.contains("Spacer()") == false,
    "native Workbench tool bar routes only its explicit blank header region into window dragging"
  )

  let fileBreadcrumb = eventRoutingSlice(
    workbench,
    from: "private struct NativeFileBreadcrumbBar",
    through: "private struct NativeFileTabStrip"
  )
  check(
    fileBreadcrumb?.contains("WindowDragSurface()") == true
      && fileBreadcrumb?.contains(".frame(minWidth: 64, maxWidth: .infinity)") == true
      && fileBreadcrumb?.contains(".frame(maxHeight: .infinity)") == true
      && fileBreadcrumb?.contains(".layoutPriority(0)") == true
      && fileBreadcrumb?.contains("ArkL10n.text(.filesPathPlaceholder, language)") == true
      && fileBreadcrumb?.contains("text: $model.pathInput") == true
      && fileBreadcrumb?.contains("ark.files.path-input") == true
      && fileBreadcrumb?.contains("ark.files.path-open") == true
      && fileBreadcrumb?.contains(".layoutPriority(1)") == true
      && fileBreadcrumb?.contains("treeVisible.toggle()") == true
      && fileBreadcrumb?.contains("ark.files.tree-visibility") == true
      && fileBreadcrumb?.contains("NativeFirstMouseIconButton(") == true
      && fileBreadcrumb?.contains("ScrollView(.horizontal") == false
      && fileBreadcrumb?.contains("Spacer(minLength: 8)") == false,
    "native Files breadcrumb releases visual whitespace to a dedicated drag region instead of an invisible horizontal scroll view"
  )

  let wikiGraph = eventRoutingSlice(
    root,
    from: "private struct NativeWikiGraph",
    through: "private struct NativeWikiDetail"
  )
  let wikiFeed = eventRoutingSlice(
    root,
    from: "private final class NativeWikiFeed",
    through: "private struct NativeWikiView"
  )
  let wikiList = eventRoutingSlice(
    root,
    from: "private struct NativeWikiView",
    through: "private struct NativeWikiGraph"
  )
  let wikiStarNode = eventRoutingSlice(
    root,
    from: "private struct NativeWikiStarNode",
    through: "private struct NativeWikiStarfieldBackdrop"
  )
  let wikiStarfield = eventRoutingSlice(
    root,
    from: "private struct NativeWikiStarfieldBackdrop",
    through: "private struct NativeWikiDetail"
  )
  check(
    wikiFeed?.contains("model.$wikiPages.removeDuplicates()") == true
      && wikiFeed?.contains("model.$wikiEdges.removeDuplicates()") == true
      && wikiFeed?.contains("model.$sessions") == true
      && wikiFeed?.contains(".combineLatest(model.$selectedSessionID)") == true
      && wikiFeed?.contains(".removeDuplicates()") == true
      && wikiFeed?.contains("@Published private(set) var language: ArkLanguagePreference") == true
      && wikiFeed?.contains("model.$languagePreference.removeDuplicates()") == true
      && wikiList?.contains("@ObservedObject var model: ArkAppModel") == false
      && wikiList?.contains("private struct NativeWikiView: View, Equatable") == true
      && root.contains("case .wiki: NativeWikiView(model: model).equatable()")
      && wikiGraph?.contains("@ObservedObject var model: ArkAppModel") == false
      && wikiGraph?.contains("private struct NativeWikiGraph: View, Equatable") == true,
    "wiki subscribes only to knowledge and running-state projections instead of every live chat publication"
  )
  check(
    wikiList?.contains("private var prioritizedListPages: [ArkWikiPage]") == true
      && wikiList?.contains("neighborIDs.contains(page.id)") == true
      && wikiList?.contains("selectedPageID: feed.selectedPageID") == true
      && wikiList?.contains(".onChange(of: pages.first?.id)") == true
      && wikiList?.contains("transaction.disablesAnimations = true") == true
      && wikiList?.contains(".onChange(of: model.selectedWikiPageID)") == false,
    "wiki page selection promotes the selected page and direct relations, then anchors the final sorted first row without stale scroll jumps"
  )
  check(
    wikiGraph?.contains("NativeWikiInteractionHost(") == true
      && wikiGraph?.contains("let interactionNodes = pages.compactMap") == true
      && wikiGraph?.contains("let groups = Dictionary(grouping: pages)") == true
      && wikiGraph?.contains("return \"type:\\(page.category.lowercased())\"") == true
      && wikiGraph?.contains("return \"community:\\(page.community.map(String.init) ?? \"unassigned\")\"") == true
      && wikiGraph?.contains("let clusterOrbit = groupKeys.count > 1") == true
      && wikiGraph?.contains("value: layoutMode") == true
      && wikiGraph?.contains("let contentRevision: Int") == true
      && wikiGraph?.contains("contentRevision: contentRevision") == true
      && wikiGraph?.contains("viewportController: viewportController") == true
      && wikiGraph?.contains("NativeWikiViewportTransform(controller: viewportController)") == true
      && wikiGraph?.contains(".overlay(alignment: .top)") == true
      && wikiGraph?.contains("graphToolbar") == true
      && wikiGraph?.contains(".overlay(alignment: .bottomLeading)") == true
      && wikiGraph?.contains(".allowsHitTesting(false)") == true
      && wikiGraph?.contains(".contentShape(Circle())") == true
      && wikiGraph?.contains("model.selectWikiPage(selectedPageID == id ? nil : id)") == true
      && wikiGraph?.contains("viewportController.reset()") == true
      && wikiGraph?.contains("NativeWikiInteractionHint(") == true
      && wikiGraph?.contains("language: language") == true
      && wikiGraph?.contains(".frame(maxWidth: .infinity, maxHeight: .infinity)") == true
      && wikiGraph?.contains("NativeWikiPulseOverlay") == true
      && wikiGraph?.contains("seed.isMultiple(of: 7)") == true
      && wikiGraph?.contains("NativeWikiThoughtFlowOverlay(") == true
      && wikiGraph?.contains("isThinking: isThinking") == true
      && wikiGraph?.contains("NativeWikiStarfieldBackdrop()") == true
      && wikiGraph?.contains("private struct NativeWikiFourPointStar: Shape") == false
      && wikiGraph?.contains("WikiNeuralBackground") == true
      && wikiGraph?.contains("private static let dustStars: [DustStar] = (0..<72)") == true
      && wikiGraph?.contains("focusedNodePositions(") == true
      && wikiGraph?.contains("let anchors = [") == true
      && wikiGraph?.contains("target = neighborTargets[page.id] ?? point") == true
      && wikiGraph?.contains("neuralFiberGeometry(") == true
      && wikiGraph?.contains("Canvas(rendersAsynchronously: true)") == true
      && wikiGraph?.contains("edgeContext.blendMode = .screen") == true
      && wikiGraph?.contains("let emphasized = focus.emphasizes(edge)") == true
      && wikiGraph?.contains(": 7") == true
      && wikiGraph?.contains("? 12 +") == true
      && wikiGraph?.contains("fiber.addCurve(") == true
      && wikiGraph?.contains("stableSignedUnit(seed, salt:") == true
      && wikiGraph?.contains(".spring(response: 0.48") == true
      && wikiGraph?.contains("SimultaneousGesture(") == false,
    "wiki graph routes wheel, blank-canvas pan, pinch, node selection, and reset without competing hit targets"
  )
  check(
    wikiGraph?.contains("ArkWikiGraphFocus(") == true
      && wikiGraph?.contains("focus.emphasizes(edge)") == true
      && wikiGraph?.contains("focus.nodeEmphasis(for: page.id)") == true
      && wikiGraph?.contains("ArkWikiGraphLayout.phase(for: page.id)") == true
      && wikiGraph?.contains("ArkWikiGraphLayout.sizeVariation(for: page.id)") == true
      && wikiGraph?.contains("hashValue") == false
      && wikiGraph?.contains("case .selected: return 4.0") == true
      && wikiGraph?.contains("case .neighbor: return 2.6") == true
      && wikiGraph?.contains("case .selected: return min(38, max(30, projected))") == true
      && wikiGraph?.contains("case .neighbor: return min(27, max(20, projected))") == true
      && wikiGraph?.contains("case .receded: return 0.34") == true
      && wikiGraph?.contains("let selectedPageID: String?") == true
      && wikiGraph?.contains("selectedID: selectedPageID") == true
      && wikiGraph?.contains("focus.selectedID == nil") == true
      && wikiGraph?.contains("model.selectWikiPage(selectedPageID == page.id ? nil : page.id)") == true
      && wikiGraph?.contains("onClear: { model.selectWikiPage(nil) }") == true
      && wikiGraph?.contains(".clipped()") == true
      && wikiGraph?.contains("endRadius: max(7, diameter * 1.10)") == true
      && wikiGraph?.contains("endRadius: max(4, diameter * 0.62)") == true
      && wikiStarNode?.contains("Circle()") == true
      && wikiStarNode?.contains("Path") == false
      && wikiStarNode?.contains("Rectangle") == false
      && wikiStarfield?.contains("Path(ellipseIn: rect)") == true
      && wikiStarfield?.contains("with: .color(colors[star.colorIndex].opacity(star.opacity))") == true
      && wikiGraph?.contains("return Color(red: 1.0, green: 0.82, blue: 0.55)") == true,
    "wiki remains a clean star field until node selection reveals only bright direct semantic relations"
  )
  check(
    wikiGraph?.contains("Timer") == false
      && wikiGraph?.contains("TimelineView") == false
      && wikiGraph?.contains("CADisplayLink") == false
      && wikiGraph?.contains("repeatForever") == false
      && wikiGraph?.contains("angularVelocity") == false,
    "wiki graph cannot regain a perpetual position-layout driver"
  )
  check(
    wikiEffects.contains("final class NativeWikiInteractionHostView<Content: View>: NSHostingView<Content>")
      && wikiEffects.contains("override var acceptsFirstResponder: Bool { true }")
      && wikiEffects.contains("override var mouseDownCanMoveWindow: Bool { false }")
      && wikiEffects.contains("isFlipped = true")
      && wikiEffects.contains("layer?.masksToBounds = true")
      && wikiEffects.contains("if point.y <= 72")
      && wikiEffects.contains("return nil")
      && wikiEffects.contains("override func mouseDown(with event: NSEvent)")
      && wikiEffects.contains("override func mouseDragged(with event: NSEvent)")
      && wikiEffects.contains("override func mouseUp(with event: NSEvent)")
      && wikiEffects.contains("override func scrollWheel(with event: NSEvent)")
      && wikiEffects.contains("override func magnify(with event: NSEvent)")
      && !wikiEffects.contains("NSMagnificationGestureRecognizer(")
      && wikiEffects.contains("override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }")
      && wikiEffects.contains("if view.contentRevision != contentRevision")
      && wikiEffects.contains("NativeWikiInteractionHint")
      && wikiEffects.contains("ArkL10n.format(")
      && wikiEffects.contains(".wikiInteractionHint")
      && !wikiEffects.contains("Text(\"\\(percent)% · 拖拽平移")
      && wikiEffects.contains("else { return nil }")
      && wikiEffects.contains("return self")
      && wikiEffects.contains("CABasicAnimation(keyPath: \"opacity\")")
      && wikiEffects.contains("CABasicAnimation(keyPath: \"transform.scale\")")
      && wikiEffects.contains("CABasicAnimation(keyPath: \"lineDashPhase\")")
      && wikiEffects.contains("final class NativeContinuousAnimationGate")
      && wikiEffects.contains("accessibilityDisplayShouldReduceMotion")
      && wikiEffects.contains("windowVisible: view.window?.isVisible == true")
      && wikiEffects.contains("windowMiniaturized: view.window?.isMiniaturized == true")
      && wikiEffects.contains("windowOccluded: view.window?.occlusionState.contains(.visible) != true")
      && wikiEffects.contains("applicationHidden: NSApp?.isHidden == true")
      && wikiEffects.contains("viewHidden: view.isHiddenOrHasHiddenAncestor")
      && wikiEffects.contains("NSWorkspace.accessibilityDisplayOptionsDidChangeNotification")
      && wikiEffects.components(separatedBy: "animationGate.windowDidChange()").count >= 3
      && wikiEffects.components(separatedBy: "view.dismantle()").count >= 3
      && wikiEffects.contains("flow.opacity = isThinking")
      && wikiEffects.contains("private var pendingLogDelta = 0.0")
      && wikiEffects.contains("scheduleDelivery()")
      && wikiEffects.contains("max(20, candidate.hitRadius * CGFloat(viewport.zoom))")
      && !wikiEffects.contains("addLocalMonitorForEvents")
      && !wikiEffects.contains("keyPath: \"position\"")
      && !wikiEffects.contains("Timer")
      && !wikiEffects.contains("TimelineView"),
    "wiki star breathing is GPU-composited while wheel zoom preserves node hit testing and static positions"
  )

  let wikiDetail = eventRoutingSlice(
    root,
    from: "private struct NativeWikiDetail",
    through: "private struct NativeDetailsPlaceholder"
  )
  check(
    wikiDetail?.contains("Text(page.body)") == true
      && wikiDetail?.contains(".textSelection(.enabled)") == true
      && wikiDetail?.contains("TextEditor") == false
      && wikiDetail?.contains("NativeCodeEditorView(") == true
      && wikiDetail?.contains("model.saveKnowledgePage(") == true
      && wikiDetail?.contains("expectedContent: baseline") == true
      && wikiDetail?.contains("if let error = saveError") == true
      && wikiDetail?.contains("@ObservedObject var model: ArkAppModel") == false
      && wikiDetail?.contains("ArkL10n.text(.wikiReload, language)") == true,
    "wiki page inspector edits through the native TextKit surface and the authoritative CAS save API"
  )

  let edges = [
    ArkWikiEdge(source: "selected", target: "outgoing"),
    ArkWikiEdge(source: "incoming", target: "selected"),
    ArkWikiEdge(source: "remote-a", target: "remote-b"),
  ]
  let focus = ArkWikiGraphFocus(selectedID: "selected", edges: edges)
  check(
    focus.nodeEmphasis(for: "selected") == .selected
      && focus.nodeEmphasis(for: "outgoing") == .neighbor
      && focus.nodeEmphasis(for: "incoming") == .neighbor
      && focus.nodeEmphasis(for: "remote-a") == .receded
      && focus.emphasizes(edges[0])
      && focus.emphasizes(edges[1])
      && !focus.emphasizes(edges[2]),
    "wiki focus projection treats incoming and outgoing direct links as the same visual neighborhood"
  )
  check(
    ArkWikiGraphFocus(selectedID: nil, edges: edges).nodeEmphasis(for: "remote-a") == .normal,
    "wiki graph shows the full field normally when no node is selected"
  )

  var viewport = ArkWikiGraphViewport()
  viewport.magnify(by: 99)
  viewport.translate(x: 24, y: -12)
  check(
    viewport.zoom == ArkWikiGraphViewport.maximumZoom
      && viewport.panX == 24
      && viewport.panY == -12,
    "wiki viewport clamps zoom and commits finite pan deltas"
  )
  viewport.reset()
  check(
    viewport == ArkWikiGraphViewport(),
    "wiki reset restores the canonical one-times zoom and zero pan"
  )
  check(
    ArkWikiGraphLayout.stableSeed(for: "concepts/example")
      == ArkWikiGraphLayout.stableSeed(for: "concepts/example")
      && ArkWikiGraphLayout.phase(for: "concepts/example").isFinite,
    "wiki graph layout uses a stable process-independent seed"
  )
}
