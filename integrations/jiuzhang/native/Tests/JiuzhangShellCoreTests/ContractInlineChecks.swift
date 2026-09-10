import Darwin
import Foundation
import AppKit
import Combine
import JiuzhangShellCore
@testable import JiuzhangShellUI

var failureCount = 0

func check(_ condition: @autoclosure () -> Bool, _ description: String) {
  if !condition() {
    print("FAIL: \(description)")
    failureCount += 1
  }
}

private final class BackendContractProbeState: @unchecked Sendable {
  private let lock = NSLock()
  private var failures = 0
  private var exitStatuses: [Int32] = []

  func check(_ condition: Bool, _ description: String) {
    guard !condition else { return }
    print("FAIL: \(description)")
    lock.lock()
    failures += 1
    lock.unlock()
  }

  func recordExit(_ status: Int32) -> Int {
    lock.lock()
    defer { lock.unlock() }
    exitStatuses.append(status)
    return exitStatuses.count
  }

  func exitStatus(at index: Int) -> Int32? {
    lock.lock()
    defer { lock.unlock() }
    guard exitStatuses.indices.contains(index) else { return nil }
    return exitStatuses[index]
  }

  var exitCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return exitStatuses.count
  }

  var failureCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return failures
  }
}

func runBackendRecoveryContractChecks() async -> Int {
  await withCheckedContinuation { continuation in
    DispatchQueue.global().async {
    let state = BackendContractProbeState()
    let backend = BackendProcess()
    let firstExitSignal = DispatchSemaphore(value: 0)
    let secondExitSignal = DispatchSemaphore(value: 0)
    let lineSignal = DispatchSemaphore(value: 0)
    let stopSignal = DispatchSemaphore(value: 0)

    backend.onLine = { line in
      if line.contains("dsh native-api: http://127.0.0.1:43129") {
        lineSignal.signal()
      }
    }
    backend.onExit = { status in
      switch state.recordExit(status) {
      case 1: firstExitSignal.signal()
      case 2: secondExitSignal.signal()
      default: break
      }
    }

    let fixture = FileManager.default.temporaryDirectory
      .appendingPathComponent("ark-backend-probe-\(UUID().uuidString).sh")
    let environment = ["PATH": "/usr/bin:/bin"]
    do {
      try "echo 'dsh native-api: http://127.0.0.1:43129'\nexec /bin/sleep 60\n".write(
        to: fixture,
        atomically: true,
        encoding: .utf8
      )
      defer { try? FileManager.default.removeItem(at: fixture) }

      try backend.start(
        executable: "/bin/sh",
        arguments: [fixture.path],
        environment: environment,
        workingDirectory: fixture.deletingLastPathComponent()
      )
      state.check(backend.isRunning, "backend runs after start")
      let firstPID = backend.processIdentifier
      state.check(firstPID != nil, "backend exposes its process identifier")
      state.check(
        lineSignal.wait(timeout: .now() + 10) == .success,
        "backend emits its readiness line"
      )
      state.check(state.exitStatus(at: 0) == nil, "backend stays alive while healthy")

      if let firstPID {
        state.check(Darwin.kill(firstPID, SIGKILL) == 0, "backend accepts the first kill probe")
        state.check(
          firstExitSignal.wait(timeout: .now() + 10) == .success,
          "backend reports the killed exit before the deadline"
        )
      }
      state.check(state.exitStatus(at: 0) != nil, "backend reports the killed exit")
      state.check(!backend.isRunning, "backend no longer running after exit")

      try backend.start(
        executable: "/bin/sh",
        arguments: [fixture.path],
        environment: environment,
        workingDirectory: fixture.deletingLastPathComponent()
      )
      state.check(backend.isRunning, "backend restarts after an unexpected exit")
      let secondPID = backend.processIdentifier
      state.check(secondPID != nil, "backend restart exposes its process identifier")
      state.check(secondPID != firstPID, "restart spawns a fresh process")
      if let secondPID {
        state.check(Darwin.kill(secondPID, SIGKILL) == 0, "backend accepts the second kill probe")
        state.check(
          secondExitSignal.wait(timeout: .now() + 10) == .success,
          "backend reports the second exit before the deadline"
        )
      }
      state.check(state.exitStatus(at: 1) != nil, "backend reports the second exit")
      state.check(!backend.isRunning, "backend cleared after the second exit")

      try backend.start(
        executable: "/bin/sh",
        arguments: [fixture.path],
        environment: environment,
        workingDirectory: fixture.deletingLastPathComponent()
      )
      do {
        try backend.start(
          executable: "/bin/sh",
          arguments: [fixture.path],
          environment: environment,
          workingDirectory: fixture.deletingLastPathComponent()
        )
        state.check(false, "double start is refused")
      } catch BackendProcessError.alreadyRunning {
        // Expected: the running process remains the sole launch owner.
      } catch {
        state.check(false, "double start reports the expected error: \(error)")
      }
      backend.stop {
        stopSignal.signal()
      }
      state.check(
        stopSignal.wait(timeout: .now() + 10) == .success,
        "backend stop completes before the deadline"
      )
      state.check(!backend.isRunning, "stop reaps the process")
      state.check(state.exitCount == 3, "backend reports every launched process exit")
    } catch {
      state.check(false, "backend probe runs: \(error)")
    }

    if backend.isRunning {
      let cleanupSignal = DispatchSemaphore(value: 0)
      backend.stop { cleanupSignal.signal() }
      state.check(
        cleanupSignal.wait(timeout: .now() + 10) == .success,
        "backend probe cleanup reaps its owned process"
      )
    }
    backend.onLine = nil
    backend.onExit = nil

    let failures = state.failureCount
    if failures > 0 {
      print("\(failures) Jiuzhang backend recovery checks failed")
    } else {
      print("Jiuzhang backend recovery checks passed")
    }
      continuation.resume(returning: failures)
    }
  }
}

func runInlineContractChecks() {
let nativeRoot = contractNativeRoot
let infoPlistURL = nativeRoot.appendingPathComponent("Resources/Info.plist")
let iconSourceURL = nativeRoot.appendingPathComponent("Resources/AppIcon.png")
let wikiBackgroundURL = nativeRoot.appendingPathComponent("Resources/WikiNeuralBackground.png")
let nodeEntitlementsURL = nativeRoot.appendingPathComponent("Resources/node.entitlements")
let buildScriptURL = nativeRoot.appendingPathComponent("build-app.sh")
let appDelegateURL = nativeRoot.appendingPathComponent("Sources/JiuzhangShell/AppDelegate.swift")
let browserURL = nativeRoot.appendingPathComponent(
  "Sources/JiuzhangShellUI/NativeWorkbenchBrowserView.swift"
)
let packageURL = nativeRoot.appendingPathComponent("Package.swift")
let repositoryRoot = nativeRoot
  .deletingLastPathComponent()
  .deletingLastPathComponent()
  .deletingLastPathComponent()
let knowledgeHostURL = repositoryRoot.appendingPathComponent(
  "packages/host/knowledge-wiki/src/index.ts"
)
if let data = try? Data(contentsOf: infoPlistURL),
   let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
{
  check(info["CFBundleDisplayName"] as? String == "Ark", "bundle displays the Ark product name")
  check(info["CFBundleExecutable"] as? String == "Ark", "bundle executable uses the product process name")
  check(info["CFBundleIdentifier"] as? String == "cn.jiuzhangtianmu.industrybrain", "bundle identifier preserves installed product identity")
  check(info["CFBundleName"] as? String == "Ark", "bundle uses the Ark product name")
  check(info["CFBundleShortVersionString"] as? String == "3.1.0", "bundle marketing version is 3.1.0")
  check(info["CFBundleVersion"] as? String == "3.1.0", "bundle version is 3.1.0")
  check(info["CFBundleIconFile"] as? String == "AppIcon", "bundle declares the generated Jiuzhang icon")
  check(info["JiuzhangRuntimeRoot"] as? String == "__RUNTIME_ROOT__", "bundle declares the selected runtime root")
  check(info["JiuzhangLauncherPath"] as? String == "__LAUNCHER_PATH__", "bundle declares the selected launcher")
  check(
    info["JiuzhangRunnerPath"] as? String == "__RUNNER_PATH__",
    "bundle declares the selected Native API runner"
  )
  check(info["SUFeedURL"] == nil, "bundle omits Web-based update feed metadata")
  check(info["SUEnableAutomaticChecks"] == nil, "bundle omits the embedded Web-based updater")
} else {
  check(false, "Info.plist parses")
}
check(FileManager.default.fileExists(atPath: iconSourceURL.path), "Ark seal PNG icon source exists")
if let iconData = try? Data(contentsOf: iconSourceURL),
   let icon = NSBitmapImageRep(data: iconData)
{
  check(icon.pixelsWide == 1024, "Ark seal icon source is 1024 pixels wide")
  check(icon.pixelsHigh == 1024, "Ark seal icon source is 1024 pixels high")
} else {
  check(false, "Ark seal icon source is a readable bitmap")
}
if let buildScript = try? String(contentsOf: buildScriptURL, encoding: .utf8) {
  check(buildScript.contains(#"app_path="${destination}/Ark.app""#), "build emits Ark.app")
  check(!buildScript.contains(#"app_path="${destination}/九章天幕行业大脑.app""#), "build omits the legacy visible app filename")
  check(!buildScript.contains(#"app_path="${destination}/ARK.app""#), "build omits the all-caps app filename")
  check(buildScript.contains(#"Resources/AppIcon.png"#), "build consumes the Ark seal PNG source")
  check(buildScript.contains(#"WikiNeuralBackground.png"#), "build embeds the native Wiki neural background")
  check(!buildScript.contains(#"Resources/AppIcon.svg"#), "build no longer consumes the legacy vector icon")
  check(buildScript.contains(#"JIUZHANG_SELF_CONTAINED"#), "build supports the self-contained distribution mode")
  check(buildScript.contains(#"ark.entitlements"#), "build signs with the hardened-runtime entitlements")
  check(
    buildScript.contains(#"--entitlements "${node_entitlements_path}" --sign "${sign_identity}" "${timestamp_flag}" "${app_path}/Contents/Resources/node/bin/node""#),
    "self-contained build signs embedded Node with the V8 entitlements"
  )
  check(buildScript.contains(#"embedded-node-ok"#), "self-contained build executes the signed embedded Node")
  check(
    buildScript.contains(#"ark_main_swift_rpaths prune "${app_path}/Contents/MacOS/Ark""#),
    "build removes audited Swift toolchain RPATHs before signing"
  )
  check(buildScript.contains(#"JIUZHANG_SIGN_IDENTITY"#), "build honors a Developer ID signing identity")
  check(buildScript.contains(#"JIUZHANG_NOTARY_PROFILE"#), "build supports notarytool submission and stapling")
  check(!buildScript.contains("Sparkle"), "build omits the WebKit-linked Sparkle updater")
  check(!buildScript.contains(#"generate_appcast"#), "build omits Web appcast generation")
  check(!buildScript.contains(#"sign_update"#), "build omits Web updater archive signing")
  check(!buildScript.contains(#"SUPublicEDKey"#), "build omits Web updater public keys")
} else {
  check(false, "native build script is readable")
}
if let resourceFiles = try? FileManager.default.contentsOfDirectory(
  at: nativeRoot.appendingPathComponent("Resources"),
  includingPropertiesForKeys: nil
) {
  let bitmapResources = resourceFiles
    .filter { ["png", "icns"].contains($0.pathExtension.lowercased()) }
    .map(\.lastPathComponent)
    .sorted()
  check(
    bitmapResources == ["AppIcon.png", "WikiNeuralBackground.png"],
    "source resources contain the Ark seal and the native Wiki neural texture only"
  )
} else {
  check(false, "source resources are readable")
}
if let knowledgeHost = try? String(contentsOf: knowledgeHostURL, encoding: .utf8) {
  check(knowledgeHost.contains("expectedContent?: string"), "Wiki Host supports compare-and-swap saves")
  check(knowledgeHost.contains("current !== request.expectedContent"), "Wiki Host rejects external modification conflicts")
  let filesystem = (try? String(contentsOf: knowledgeHostURL.deletingLastPathComponent().appendingPathComponent("filesystem.ts"), encoding: .utf8)) ?? ""
  check(knowledgeHost.contains("atomicWriteFile(full, request.content)")
    && filesystem.contains("renameSync(temporary, path)"), "Wiki Host commits page saves atomically")
  check(filesystem.contains("mode = 0o600")
    && filesystem.contains("constants.O_EXCL"), "Wiki Host creates private temporary save files")
  check(!knowledgeHost.contains("writeFileSync(full, request.content)"), "Wiki Host never overwrites canonical pages directly")
} else {
  check(false, "Wiki Host lifecycle source is readable")
}
if let backgroundData = try? Data(contentsOf: wikiBackgroundURL),
   let background = NSBitmapImageRep(data: backgroundData)
{
  check(background.pixelsWide >= 1200, "native Wiki neural texture is wide enough for the graph canvas")
  check(background.pixelsHigh >= 700, "native Wiki neural texture is tall enough for the graph canvas")
} else {
  check(false, "native Wiki neural texture is a readable bitmap")
}
if let data = try? Data(contentsOf: nodeEntitlementsURL),
   let entitlements = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
{
  check(entitlements["com.apple.security.cs.allow-jit"] as? Bool == true, "embedded Node allows V8 JIT")
  check(
    entitlements["com.apple.security.cs.allow-unsigned-executable-memory"] as? Bool == true,
    "embedded Node allows V8 executable memory"
  )
} else {
  check(false, "embedded Node entitlements parse")
}
if let appDelegate = try? String(contentsOf: appDelegateURL, encoding: .utf8),
   let browser = try? String(contentsOf: browserURL, encoding: .utf8),
   let package = try? String(contentsOf: packageURL, encoding: .utf8)
{
  check(!appDelegate.contains("WKWebView"), "native application delegate omits WKWebView")
  check(!appDelegate.contains("import WebKit"), "native application delegate omits WebKit")
  check(!package.contains("linkedFramework(\"WebKit\")"), "native package does not link WebKit")
  check(!package.contains("Sparkle"), "native package omits the WebKit-linked updater")
  check(
    browser.contains("NSWorkspace.shared.open(url)")
      && !browser.contains("import WebKit")
      && !browser.contains("WKWebView"),
    "native Browser opens validated URLs in the default browser"
  )
  check(appDelegate.contains("NSHostingView<ArkRootView>"), "native application hosts the Ark SwiftUI root")
} else {
  check(false, "native application sources are readable")
}

MainActor.assumeIsolated {
  check(jiuzhangVisibleApplicationName == "Ark", "native shell exposes the Ark product name")
  let mainMenu = makeJiuzhangMainMenu(applicationName: jiuzhangVisibleApplicationName)
  check(mainMenu.items.first?.title == "Ark", "application menu displays Ark")
  let fileMenu = mainMenu.items.first(where: { $0.title == "文件" })?.submenu
  let newConversation = fileMenu?.items.first(where: {
    $0.identifier?.rawValue == "ark.menu.new-conversation"
  })
  check(newConversation != nil, "application menu exposes a native new-conversation command")
  check(
    newConversation?.target === NativeConversationCommandCenter.shared
      && newConversation?.action.map(NSStringFromSelector) == "beginNewConversation:"
      && newConversation?.keyEquivalent == "n"
      && newConversation?.keyEquivalentModifierMask == [.command],
    "Command-N routes through the native conversation owner before the composer input method"
  )
  var newConversationEvents = 0
  let newConversationObserver = NotificationCenter.default.addObserver(
    forName: .arkBeginNewConversation,
    object: nil,
    queue: nil
  ) { _ in newConversationEvents += 1 }
  if let newConversation { NativeConversationCommandCenter.shared.beginNewConversation(newConversation) }
  NotificationCenter.default.removeObserver(newConversationObserver)
  check(newConversationEvents == 1, "the native new-conversation command publishes exactly once")
  let rootSource = try? String(
    contentsOf: contractNativeRoot.appendingPathComponent("Sources/JiuzhangShellUI/ArkRootView.swift"),
    encoding: .utf8
  )
  check(
    rootSource?.contains("publisher(for: .arkBeginNewConversation)") == true
      && rootSource?.contains("model.beginNewConversation()") == true,
    "the native root consumes Command-N through the same new-conversation owner as the sidebar"
  )
  let editMenu = mainMenu.items.first(where: { $0.title == "编辑" })?.submenu
  check(editMenu != nil, "application menu exposes Edit")
  let expectedBindings = [
    ("undo:", "z", false),
    ("redo:", "z", true),
    ("cut:", "x", false),
    ("copy:", "c", false),
    ("paste:", "v", false),
    ("selectAll:", "a", false),
  ]
  for (actionName, keyEquivalent, requiresShift) in expectedBindings {
    let item = editMenu?.items.first(where: {
      $0.action.map(NSStringFromSelector) == actionName
    })
    check(item != nil, "Edit menu contains \(actionName)")
    check(item?.target == nil, "\(actionName) follows the first-responder chain")
    check(item?.keyEquivalent == keyEquivalent, "\(actionName) uses Command-\(keyEquivalent.uppercased())")
    check(item?.keyEquivalentModifierMask.contains(.command) == true, "\(actionName) requires Command")
    check(
      item?.keyEquivalentModifierMask.contains(.shift) == requiresShift,
      "\(actionName) has the expected Shift modifier"
    )
  }

  let workbenchMenu = mainMenu.items.first(where: { $0.title == "工作台" })?.submenu
  check(workbenchMenu != nil, "application menu exposes Workbench commands")
  let commandCenter = NativeWorkbenchCommandCenter.shared
  var routedKinds: [NativeWorkbenchTabKind] = []
  let routeSubscription = commandCenter.openTool.sink { routedKinds.append($0) }
  let expectedWorkbenchBindings: [
    (NativeWorkbenchTabKind, String, NSEvent.ModifierFlags)
  ] = [
    (.review, "g", [.control, .shift]),
    (.terminal, "`", [.control]),
    (.browser, "t", [.command]),
    (.files, "p", [.command]),
  ]
  for (kind, keyEquivalent, modifiers) in expectedWorkbenchBindings {
    let item = workbenchMenu?.items.first(where: {
      ($0.representedObject as? String) == kind.rawValue
    })
    check(item != nil, "Workbench menu contains \(kind.rawValue)")
    check(item?.target === commandCenter, "\(kind.rawValue) routes through one Workbench owner")
    check(
      item?.action.map(NSStringFromSelector) == "routeWorkbenchTool:",
      "\(kind.rawValue) uses the typed Workbench route"
    )
    check(item?.keyEquivalent == keyEquivalent, "\(kind.rawValue) uses its global shortcut")
    check(
      item?.keyEquivalentModifierMask == modifiers,
      "\(kind.rawValue) uses the expected shortcut modifiers"
    )
    check(
      item?.identifier?.rawValue == "ark.menu.workbench.\(kind.rawValue)",
      "\(kind.rawValue) menu command is accessible by stable identity"
    )
    if let item { commandCenter.routeWorkbenchTool(item) }
  }
  check(
    routedKinds == expectedWorkbenchBindings.map { $0.0 },
    "Workbench menu commands publish each typed tool intent exactly once"
  )
  withExtendedLifetime(routeSubscription) {}
}

let readyLineURL = JiuzhangShellContract.readinessURL(
  from: "dsh native-api: http://127.0.0.1:43129\r"
)
check(readyLineURL?.absoluteString == "http://127.0.0.1:43129", "readiness parses loopback")
check(
  ArkAPIClient.endpointURL(
    baseURL: URL(string: "http://127.0.0.1:3080")!,
    method: "knowledgeWiki/pageContent"
  ).absoluteString == "http://127.0.0.1:3080/api/knowledgeWiki/pageContent",
  "native RPC endpoint preserves slash Remote paths"
)
let muxEventRequest = try? ArkEventPump.eventRequest(
  baseURL: URL(string: "http://127.0.0.1:3080")!,
  apiToken: "native-event-token",
  channel: .mux
)
check(
  muxEventRequest?.url?.absoluteString == "ws://127.0.0.1:3080/api/events/mux",
  "native event pump resolves the mux WebSocket endpoint"
)
check(
  muxEventRequest?.value(forHTTPHeaderField: "Authorization") == "Bearer native-event-token",
  "native event pump authenticates its WebSocket handshake"
)
let hostEventURL = try? ArkEventPump.eventURL(
  baseURL: URL(string: "https://127.0.0.1:3080")!,
  channel: .host
)
check(
  hostEventURL?.absoluteString == "wss://127.0.0.1:3080/api/events/host",
  "native event pump resolves the host secure WebSocket endpoint"
)
let decodedEvent = try? ArkEventPump.decodeFrame(
  #"{"type":"server-request","rpcId":"event-1","method":"session/event","payload":{"type":"session/event","sessionId":"session-1","event":{"seq":1,"type":"turn/start","time":1,"data":{"turn":1}},"future":{"kept":true}}}"#,
  channel: .mux
)
check(decodedEvent?.rpcID == "event-1", "native event pump preserves the server request id")
check(decodedEvent?.method == "session/event", "native event pump preserves the event method")
check(
  decodedEvent?.payload["future"]?["kept"]?.boolValue == true,
  "native event pump preserves merge-extensible JSON payloads"
)
check(
  (try? ArkEventPump.decodeFrame(
    #"{"type":"server-request","rpcId":"event-2","method":"session/event","payload":{"type":"host/session-status"}}"#,
    channel: .mux
  )) == nil,
  "native event pump rejects mismatched envelope and payload methods"
)
let chunkMessages = ArkAPIClient.messages(from: [
  ArkHistoryEvent(
    id: 1,
    type: "assistant/chunk",
    time: Date(timeIntervalSince1970: 1),
    data: .object([
      "turn": .number(1),
      "step": .number(1),
      "chunk": .object(["type": .string("text-delta"), "text": .string("原生")]),
    ]),
    view: nil
  ),
  ArkHistoryEvent(
    id: 2,
    type: "assistant/chunk",
    time: Date(timeIntervalSince1970: 2),
    data: .object([
      "turn": .number(1),
      "step": .number(1),
      "chunk": .object(["type": .string("text-delta"), "text": .string("回复")]),
    ]),
    view: nil
  ),
])
check(chunkMessages.map(\.text) == ["原生回复"], "native message projection folds assistant text chunks")
var incrementalProjection = ArkMessageProjection()
_ = incrementalProjection.append(ArkHistoryEvent(
  id: 3,
  type: "assistant/chunk",
  time: Date(timeIntervalSince1970: 3),
  data: .object([
    "turn": .number(2),
    "step": .number(1),
    "chunk": .object(["type": .string("reasoning-delta"), "text": .string("先检查")]),
  ]),
  view: nil
))
_ = incrementalProjection.append(ArkHistoryEvent(
  id: 4,
  type: "assistant/chunk",
  time: Date(timeIntervalSince1970: 4),
  data: .object([
    "turn": .number(2),
    "step": .number(1),
    "chunk": .object(["type": .string("text-delta"), "text": .string("结论")]),
  ]),
  view: nil
))
check(
  incrementalProjection.messages.first?.reasoning == "先检查"
    && incrementalProjection.messages.first?.text == "结论",
  "native incremental projection preserves reasoning beside visible text"
)
_ = incrementalProjection.append(ArkHistoryEvent(
  id: 5,
  type: "llm/retry",
  time: Date(timeIntervalSince1970: 5),
  data: .object(["turn": .number(2), "step": .number(1)]),
  view: nil
))
_ = incrementalProjection.append(ArkHistoryEvent(
  id: 6,
  type: "assistant/chunk",
  time: Date(timeIntervalSince1970: 6),
  data: .object([
    "turn": .number(2),
    "step": .number(1),
    "chunk": .object(["type": .string("text-delta"), "text": .string("重试成功")]),
  ]),
  view: nil
))
check(
  incrementalProjection.messages.map(\.text) == ["重试成功"],
  "native message projection discards failed partial output before retry"
)
let imageMessages = ArkAPIClient.messages(from: [ArkHistoryEvent(
  id: 7,
  type: "user/message",
  time: Date(timeIntervalSince1970: 5),
  data: .object([
    "content": .array([.object([
      "type": .string("image"),
      "attachment": .object(["attachmentId": .string("sha256:image")]),
    ])]),
  ]),
  view: nil
)])
check(
  imageMessages.first?.attachmentIDs == ["sha256:image"],
  "native message projection keeps image-only messages visible"
)
var toolProjection = ArkToolProjection()
toolProjection.append(ArkHistoryEvent(
  id: 6,
  type: "tool/call",
  time: Date(timeIntervalSince1970: 6),
  data: .object([
    "callId": .string("call-native"),
    "name": .string("bash"),
    "arguments": .string("{\"command\":\"pwd\"}"),
  ]),
  view: .object([
    "for": .string("call"),
    "view": .object(["card": .string("terminal"), "title": .string("pwd")]),
  ])
))
toolProjection.append(ArkHistoryEvent(
  id: 7,
  type: "tool/result",
  time: Date(timeIntervalSince1970: 7),
  data: .object([
    "message": .object([
      "source": .object(["callId": .string("call-native")]),
      "content": .array([.object([
        "type": .string("tool-result"),
        "isError": .bool(false),
        "content": .array([.object(["type": .string("text"), "text": .string("/tmp")])]),
      ])]),
    ]),
  ]),
  view: .object([
    "for": .string("result"),
    "view": .object([
      "card": .string("terminal"),
      "output": .string("/tmp"),
      "exitCode": .number(0),
    ]),
  ])
))
check(
  toolProjection.activities.first?.result == "/tmp"
    && toolProjection.activities.first?.isError == false
    && toolProjection.activities.first?.callPresentation?["title"]?.stringValue == "pwd"
    && toolProjection.activities.first?.resultPresentation?["output"]?.stringValue == "/tmp",
  "native tool projection pairs modern nested tool results with their calls"
)









for rejected in [
  "dsh web: http://127.0.0.1:43129",
  "dsh native-api: http://localhost:43129",
  "dsh native-api: http://0.0.0.0:43129",
  "dsh native-api: https://127.0.0.1:43129",
  "dsh native-api: http://127.0.0.1:0",
  "dsh native-api: http://127.0.0.1:65536",
  "dsh native-api: http://127.0.0.1:43129/path",
] {
  check(JiuzhangShellContract.readinessURL(from: rejected) == nil, "readiness rejects \(rejected)")
}

check(
  JiuzhangShellContract.launchArguments(launcherPath: "/checkout/start.mjs")
    == [
      "/checkout/start.mjs",
      "--parent-pid", String(ProcessInfo.processInfo.processIdentifier),
      "--port", "0",
    ],
  "launcher hands the UI pid to the parent-death watcher and requests a collision-free loopback port"
)

let harnessHome = URL(
  fileURLWithPath: "/Users/example/Library/Application Support/Ark/Harness", isDirectory: true
)
let dataLocations = try! JiuzhangShellContract.launchDataLocations(
  info: [:], productionRoot: harnessHome.deletingLastPathComponent()
)
let environment = JiuzhangShellContract.childEnvironment(
  base: [
    "HOME": "/Users/example",
    "PATH": "/usr/bin",
    "TMPDIR": "/private/tmp/example/",
    "LANG": "zh_CN.UTF-8",
    "DEEPSEEK_API_KEY": "must-not-leak",
    "SERVICE_TOKEN": "must-not-leak",
    "HTTPS_PROXY": "http://127.0.0.1:1234",
    "NODE_OPTIONS": "--require=/tmp/inject.js",
    "DSH_HOME": "/Users/example/.dsh",
  ],
  harnessHome: harnessHome,
  apiToken: "native-launch-token",
  dataLocations: dataLocations
)
check(environment["HOME"] == "/Users/example", "environment preserves HOME")
check(environment["PATH"] == "/usr/bin", "environment preserves PATH")
check(environment["TMPDIR"] == "/private/tmp/example/", "environment preserves TMPDIR")
check(environment["LANG"] == "zh_CN.UTF-8", "environment preserves LANG")
check(environment["JIUZHANG_DSH_HOME"] == harnessHome.path, "environment isolates Jiuzhang home")
check(environment["DSH_HOME"] == harnessHome.path, "environment overrides Harness home")
check(
  environment["ARK_MAIN_ROOT"] == dataLocations.knowledgeRoot.path
    && environment["ARK_WIKI_ROOT"] == dataLocations.wikiRoot.path
    && environment["ARK_DEFAULT_WORKSPACE"] == dataLocations.sessionWorkspace.path,
  "all child data locations share the validated launch owner"
)
check(environment["DSH_PERMISSION_MODE"] == "read-only", "environment forces read-only mode")
check(environment["DSH_TELEMETRY_DISABLED"] == "1", "environment disables telemetry")
check(environment["DSH_API_TOKEN"] == "native-launch-token", "environment passes the native launch token")
check(
  environment["ARK_MAIN_ROOT"]?.hasSuffix("/Library/Application Support/Ark/Knowledge") == true,
  "native knowledge root stays outside the Ark source checkout"
)
check(
  environment["ARK_WIKI_ROOT"]?.hasSuffix("/Library/Application Support/Ark/Knowledge/wiki") == true,
  "native main wiki stays in product-owned application data"
)
check(environment["ARK_MAIN_ROOT"] != "/Users/hui/ark", "native runtime never opens its source root")
check(environment["DEEPSEEK_API_KEY"] == nil, "environment drops API keys")
check(environment["SERVICE_TOKEN"] == nil, "environment drops tokens")
check(environment["HTTPS_PROXY"] == nil, "environment drops proxy injection")
check(environment["NODE_OPTIONS"] == nil, "environment drops Node injection")
check(
  JiuzhangShellContract.defaultHarnessHome().path
    .hasSuffix("/Library/Application Support/Ark/Harness"),
  "default Harness home is product-isolated"
)
check(
  JiuzhangShellContract.defaultSessionWorkspace().path
    .hasSuffix("/Library/Application Support/Ark/Default Workspace"),
  "blank chats use an isolated default workspace"
)
check(
  !JiuzhangShellContract.defaultSessionWorkspace().path.hasPrefix("/Applications/Ark.app"),
  "blank chats never open the installed Ark runtime"
)
check(
  JiuzhangShellContract.defaultSessionWorkspace().path != "/Users/hui/ark",
  "blank chats never open the Ark source checkout"
)
let protectedSource = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("ark", isDirectory: true).path
check(
  JiuzhangShellContract.protectedWorkspaceReason(path: protectedSource) == nil,
  "Ark source remains available as an explicit maintenance Workspace"
)
check(
  JiuzhangShellContract.protectedWorkspaceReason(
    path: JiuzhangShellContract.defaultKnowledgeRoot().path
  ) != nil,
  "Ark product data cannot be registered as a Workspace"
)
check(
  JiuzhangShellContract.protectedWorkspaceReason(path: "/Applications/Ark.app") != nil,
  "Ark app/runtime cannot be registered as a Workspace"
)
check(
  JiuzhangShellContract.protectedWorkspaceReason(path: "/private/tmp/ark-user-project") == nil,
  "an unrelated user project remains eligible as a Workspace"
)

let runtimeFixture = FileManager.default.temporaryDirectory
  .appendingPathComponent("jiuzhang-runtime-contract-\(UUID().uuidString)", isDirectory: true)
let runtimeRunner = runtimeFixture
  .appendingPathComponent("node_modules/@deepseek-ai/dsh-native-api-runner/lib/bin.js")
let runtimeLauncher = runtimeFixture.appendingPathComponent("start.mjs")
let runtimeNode = runtimeFixture.appendingPathComponent("node")
defer { try? FileManager.default.removeItem(at: runtimeFixture) }
do {
  try FileManager.default.createDirectory(
    at: runtimeRunner.deletingLastPathComponent(),
    withIntermediateDirectories: true
  )
  check(FileManager.default.createFile(atPath: runtimeLauncher.path, contents: Data()), "runtime fixture creates launcher")
  check(
    FileManager.default.createFile(atPath: runtimeRunner.path, contents: Data()),
    "runtime fixture creates Native API runner"
  )
  check(FileManager.default.createFile(atPath: runtimeNode.path, contents: Data()), "runtime fixture creates Node executable")
  try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: runtimeNode.path)
} catch {
  check(false, "runtime fixture is writable: \(error)")
}
check(
  JiuzhangShellContract.runtimePathsAreUsable(
    nodeExecutable: runtimeNode.path,
    launcherPath: runtimeLauncher.path,
    runnerPath: runtimeRunner.path,
    runtimeRoot: runtimeFixture.path
  ),
  "runtime accepts an absolute existing directory with readable launcher and runner"
)
check(
  !JiuzhangShellContract.runtimePathsAreUsable(
    nodeExecutable: runtimeNode.path,
    launcherPath: runtimeLauncher.path,
    runnerPath: runtimeRunner.path,
    runtimeRoot: "relative/runtime"
  ),
  "runtime rejects a relative root"
)
check(
  !JiuzhangShellContract.runtimePathsAreUsable(
    nodeExecutable: runtimeNode.path,
    launcherPath: runtimeLauncher.path,
    runnerPath: runtimeFixture.appendingPathComponent("missing-runner.js").path,
    runtimeRoot: runtimeFixture.path
  ),
  "runtime rejects a missing runner"
)
check(
  !JiuzhangShellContract.runtimePathsAreUsable(
    nodeExecutable: runtimeNode.path,
    launcherPath: runtimeLauncher.path,
    runnerPath: runtimeNode.path,
    runtimeRoot: runtimeFixture.path
  ),
  "runtime rejects a runner outside its required location"
)

}
