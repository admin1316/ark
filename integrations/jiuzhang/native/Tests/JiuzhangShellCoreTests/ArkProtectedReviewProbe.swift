import AppKit
import Foundation
import SwiftUI
@testable import JiuzhangShellCore
@testable import JiuzhangShellUI

/// Renders the actual existing PlanReview view with an isolated fixture model.
/// It starts no runtime, sends no API request and admits no authority.
@MainActor
func runArkProtectedReviewProbe(output: URL) -> Int32 {
  do {
    _ = NSApplication.shared
    let suite = "ark-protected-review-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let root = URL(fileURLWithPath: "/private/tmp/ark-protected-review-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let endpoint = URL(string: "http://fixture.invalid")!
    let transport = URLSession(configuration: .ephemeral)
    defer { transport.invalidateAndCancel() }
    let model = ArkAppModel(client: ArkAPIClient(baseURL: endpoint, apiToken: "fixture", session: transport),
      interactions: ArkInteractionAPI(baseURL: endpoint, apiToken: "fixture", session: transport),
      eventPump: ArkEventPump(baseURL: endpoint, apiToken: "fixture"), fallbackWikiRoot: root,
      documentStore: ArkDocumentReferenceStore(rootURL: root), defaults: defaults)
    let hash = String(repeating: "a", count: 64)
    let descriptor = ArkProtectedTrialDescriptor(grantHash: hash, preRegistrationHash: String(repeating: "b", count: 64),
      proposalHash: hash, candidateHash: String(repeating: "c", count: 64), sourceBindingHash: String(repeating: "d", count: 64),
      projectRoot: "/fixture/registered-project", profileIdentity: "fixture-profile", buildIdentity: "fixture-build",
      expiresAt: "2099-01-01T00:00:00.000Z", sessionIDs: ["fixture-baseline", "fixture-candidate"],
      fixedOracleIDs: ["single-line-v1"], operationLimits: ["evaluateCapturedUse": 2, "finalizeMeasuredTrial": 1])
    let view = NSHostingView(rootView: VStack(alignment: .leading) {
      Text("SOURCE FIXTURE · No authority provisioned").font(.system(size: 12, weight: .medium)).padding(.horizontal, 14)
      NativePlanReviewPanel(model: model, protectedTrial: descriptor)
    }.padding(12).frame(width: 820, height: 450).background(Color(nsColor: .windowBackgroundColor)))
    view.frame = NSRect(x: 0, y: 0, width: 820, height: 450)
    let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = view
    view.layoutSubtreeIfNeeded()
    guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return 1 }
    view.cacheDisplay(in: view.bounds, to: bitmap)
    guard let png = bitmap.representation(using: .png, properties: [:]) else { return 1 }
    try png.write(to: output)
    window.orderOut(nil)
    print("protected-review-source-fixture-rendered")
    return 0
  } catch { print("protected review probe failed: \(error)"); return 1 }
}
