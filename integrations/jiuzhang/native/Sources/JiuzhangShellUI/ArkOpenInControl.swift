import AppKit
import SwiftUI

enum ArkWorkspaceOpenDestination: String, CaseIterable, Identifiable, Sendable {
  case finder, terminal
  var id: String { rawValue }
  var systemImage: String { self == .finder ? "folder" : "terminal" }
  var applicationURL: URL {
    URL(fileURLWithPath: self == .finder
      ? "/System/Library/CoreServices/Finder.app"
      : "/System/Applications/Utilities/Terminal.app")
  }
  func title(_ language: ArkLanguagePreference) -> String {
    ArkL10n.text(self == .finder ? .openInFinder : .openInTerminal, language)
  }
}

@MainActor
enum ArkWorkspaceOpener {
  enum Failure: Error { case unavailableDirectory, launchFailed }
  typealias Launch = @MainActor (URL, URL) async throws -> Void

  /// Pass a file URL directly to Launch Services; workspace names never become shell code.
  static func open(_ path: String, destination: ArkWorkspaceOpenDestination, launch: Launch? = nil) async throws {
    guard path.hasPrefix("/"), !path.contains("\0") else { throw Failure.unavailableDirectory }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
      throw Failure.unavailableDirectory
    }
    let url = URL(fileURLWithPath: path, isDirectory: true)
    if let launch { try await launch(url, destination.applicationURL) }
    else { try await launchApplication(url, application: destination.applicationURL) }
  }

  /// The caller resolves and validates the produced file with NativeWorkspaceAccess.
  static func openProducedFile(_ url: URL, launch: ((URL) -> Bool)? = nil) throws {
    let accepted = launch?(url) ?? NSWorkspace.shared.open(url)
    guard accepted else { throw Failure.launchFailed }
  }

  static func failureMessage(_ error: Error, language: ArkLanguagePreference) -> String {
    if case Failure.unavailableDirectory = error { return ArkL10n.text(.openInUnavailable, language) }
    return ArkL10n.text(.openInFailed, language)
  }

  private static func launchApplication(_ directory: URL, application: URL) async throws {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      NSWorkspace.shared.open([directory], withApplicationAt: application, configuration: configuration) { app, error in
        if let error { continuation.resume(throwing: error) }
        else if app == nil { continuation.resume(throwing: Failure.launchFailed) }
        else { continuation.resume() }
      }
    }
  }
}

struct NativeOpenInAppMenu: View {
  @ObservedObject var model: ArkAppModel
  @State private var opening = false
  @State private var openError: String?

  var body: some View {
    Menu {
      ForEach(ArkWorkspaceOpenDestination.allCases) { destination in
        Button {
          guard let path = model.selectedWorkspace?.path, !opening else { return }
          opening = true
          Task { @MainActor in
            defer { opening = false }
            do { try await ArkWorkspaceOpener.open(path, destination: destination) }
            catch {
              openError = ArkWorkspaceOpener.failureMessage(error, language: model.languagePreference)
            }
          }
        } label: {
          Label(destination.title(model.languagePreference), systemImage: destination.systemImage)
        }
      }
    } label: {
      Image(systemName: "arrow.up.forward.app")
        .frame(width: 28, height: 28)
        .contentShape(Rectangle())
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .disabled(model.selectedWorkspace == nil || opening)
    .help(ArkL10n.text(.openInAppTitle, model.languagePreference))
    .accessibilityLabel(ArkL10n.text(.openInAppTitle, model.languagePreference))
    .accessibilityIdentifier("ark.session.open-in")
    .alert(ArkL10n.text(.openInFailed, model.languagePreference), isPresented: Binding(
      get: { openError != nil }, set: { if !$0 { openError = nil } }
    )) {
      Button(ArkL10n.text(.openInClose, model.languagePreference)) { openError = nil }
    } message: { Text(openError ?? "") }
  }
}
