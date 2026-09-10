import AppKit
import JiuzhangShellCore
import SwiftUI

/// Normalize one user-entered address without admitting credential-bearing or non-Web URLs.
func validatedExternalBrowserURL(_ raw: String) -> URL? {
  let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }
  let normalized = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
  guard let components = URLComponents(string: normalized),
        let scheme = components.scheme?.lowercased(),
        ["http", "https"].contains(scheme),
        components.host?.isEmpty == false,
        components.user == nil,
        components.password == nil
  else {
    return nil
  }
  return components.url
}

/// Browser-free page reader backed by the Host's SSRF-safe WebFetch provider.
@MainActor
final class NativeWorkbenchBrowserSession: ObservableObject {
  typealias Reader = (URL) async throws -> ArkWorkbenchWebDocument

  var language: ArkLanguagePreference = .zh

  @Published var address = ""
  @Published private(set) var title = ""
  @Published private(set) var document: ArkWorkbenchWebDocument?
  @Published private(set) var isLoading = false
  @Published private(set) var validationMessage: String?
  private let reader: Reader?
  private var navigationTask: Task<Void, Never>?
  private var navigationRevision = 0

  init(reader: Reader? = nil) {
    self.reader = reader
  }

  func navigate() {
    navigationTask?.cancel()
    navigationTask = nil
    navigationRevision &+= 1
    let revision = navigationRevision
    isLoading = false
    document = nil
    title = ""
    validationMessage = nil
    guard let url = validatedExternalBrowserURL(address) else {
      validationMessage = ArkL10n.text(.workbenchBrowserInvalid, language)
      return
    }
    guard let reader else {
      validationMessage = ArkL10n.text(.workbenchBrowserUnavailable, language)
      return
    }
    isLoading = true
    address = url.absoluteString
    title = url.host ?? ""
    navigationTask = Task { [weak self] in
      do {
        let document = try await reader(url)
        try Task.checkCancellation()
        guard let self, revision == self.navigationRevision else { return }
        self.document = document
        self.address = document.url
        self.title = document.markdown
          .split(separator: "\n")
          .first(where: { $0.hasPrefix("# ") })
          .map { String($0.dropFirst(2)).trimmingCharacters(in: .whitespaces) }
          ?? document.title
        self.isLoading = false
        self.validationMessage = nil
      } catch is CancellationError {
        guard let self, revision == self.navigationRevision else { return }
        self.isLoading = false
      } catch {
        guard let self, revision == self.navigationRevision else { return }
        self.isLoading = false
        self.validationMessage = error.localizedDescription
      }
    }
  }

  func openExternally() {
    let raw = document?.url ?? address
    guard let url = validatedExternalBrowserURL(raw) else {
      validationMessage = ArkL10n.text(.workbenchBrowserInvalid, language)
      return
    }
    guard NSWorkspace.shared.open(url) else {
      validationMessage = ArkL10n.text(.workbenchBrowserOpenFailed, language)
      return
    }
    validationMessage = nil
  }

  func cancel() {
    navigationRevision &+= 1
    navigationTask?.cancel()
    navigationTask = nil
    isLoading = false
  }
}

struct NativeWorkbenchBrowserView: View {
  @ObservedObject var session: NativeWorkbenchBrowserSession
  let language: ArkLanguagePreference

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        TextField(
          ArkL10n.text(.workbenchBrowserPlaceholder, language),
          text: $session.address
        )
        .textFieldStyle(.roundedBorder)
        .onSubmit(session.navigate)
        Button(ArkL10n.text(.workbenchBrowserOpen, language), action: session.navigate)
          .buttonStyle(.borderedProminent)
          .disabled(session.isLoading)
        Button(action: session.openExternally) {
          Image(systemName: "arrow.up.right.square")
        }
        .buttonStyle(.bordered)
        .help(ArkL10n.text(.workbenchBrowserOpenExternal, language))
        .accessibilityLabel(ArkL10n.text(.workbenchBrowserOpenExternal, language))
        if !session.title.isEmpty {
          Text(session.title)
            .font(.system(size: 10))
            .foregroundStyle(Color.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .frame(maxWidth: 180)
        }
      }
      .padding(.horizontal, 10)
      .frame(height: 42)
      .background(Color(nsColor: .controlBackgroundColor))
      Divider()

      if session.isLoading {
        VStack(spacing: 10) {
          ProgressView()
            .controlSize(.small)
          Text(ArkL10n.text(.workbenchBrowserLoading, language))
            .font(.system(size: 11))
        }
        .foregroundStyle(Color.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if let document = session.document {
        VStack(spacing: 0) {
          HStack(spacing: 8) {
            Text(session.title)
              .font(.system(size: 12, weight: .semibold))
              .lineLimit(1)
            Spacer(minLength: 8)
            Text("HTTP \(document.statusCode)")
              .font(.system(size: 10, design: .monospaced))
              .foregroundStyle(document.statusCode >= 400 ? Color.red : Color.secondary)
            if document.truncated {
              Text(ArkL10n.text(.workbenchBrowserTruncated, language))
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(Color.orange)
            }
          }
          .padding(.horizontal, 12)
          .frame(height: 34)
          .background(Color(nsColor: .controlBackgroundColor))
          Divider()
          if document.statusCode >= 400 {
            Text(ArkL10n.format(
              .workbenchBrowserHTTPFailure,
              language,
              arguments: [String(document.statusCode)]
            ))
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Color.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            Divider()
          }
          ScrollView {
            NativeMarkdownDocument(
              text: document.markdown,
              baseFontSize: 13,
              openURLAction: { url in
                guard validatedExternalBrowserURL(url.absoluteString) != nil else {
                  return .discarded
                }
                session.address = url.absoluteString
                session.navigate()
                return .handled
              }
            )
              .textSelection(.enabled)
              .frame(maxWidth: 920, alignment: .leading)
              .padding(.horizontal, 18)
              .padding(.vertical, 16)
              .frame(maxWidth: .infinity, alignment: .topLeading)
          }
          .accessibilityIdentifier("ark.workbench.browser.reader")
        }
      } else {
        VStack(spacing: 10) {
          Image(systemName: "doc.text.magnifyingglass")
            .font(.system(size: 30, weight: .medium))
          Text(ArkL10n.text(.workbenchBrowser, language))
            .font(.system(size: 15, weight: .semibold))
          Text(ArkL10n.text(.workbenchBrowserDetail, language))
            .font(.system(size: 11))
            .multilineTextAlignment(.center)
            .frame(maxWidth: 480)
        }
        .foregroundStyle(Color.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }

      if let validationMessage = session.validationMessage {
        Text(validationMessage)
          .font(.system(size: 10))
          .foregroundStyle(Color.red)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 10)
          .frame(minHeight: 26)
          .background(Color(nsColor: .controlBackgroundColor))
      }
    }
    .accessibilityIdentifier("ark.workbench.browser")
    .onAppear { session.language = language }
    .onDisappear(perform: session.cancel)
    .onChange(of: language) { session.language = $0 }
  }
}
