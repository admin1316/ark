import JiuzhangShellCore
import SwiftUI

enum ArkConnectionHealth {
  static func primary(_ states: [ArkEventChannel: ArkEventConnectionState]) -> ArkEventConnectionState {
    let values = ArkEventChannel.allCases.map { states[$0] ?? .connecting }
    if values.contains(.degraded) { return .degraded }
    return values.allSatisfy { $0 == .connected } ? .connected : .connecting
  }
}

/// 两个独立下行通道中较差的健康状态。
///
/// 只在通道非健康时出现：`connecting`（启动或重连中）与 `degraded`（事件流报告错误）。
/// 健康时完全隐藏，避免常驻噪声；`degraded` 时提供「立即重连」，让用户不必重启应用。
struct NativeConnectionStatusPill: View {
  @ObservedObject var model: ArkAppModel

  private var state: ArkEventConnectionState {
    model.primaryEventConnectionState
  }

  private var tint: Color {
    switch state {
    case .connected: return .green
    case .connecting: return .orange
    case .degraded: return .red
    }
  }

  private func title(_ state: ArkEventConnectionState) -> String {
    switch state {
    case .connected: return ArkL10n.text(.connectionConnected, model.languagePreference)
    case .connecting: return ArkL10n.text(.connectionConnecting, model.languagePreference)
    case .degraded: return ArkL10n.text(.connectionDegraded, model.languagePreference)
    }
  }

  var body: some View {
    if state == .connected {
      EmptyView()
    } else {
      HStack(spacing: 6) {
        Circle()
          .fill(tint)
          .frame(width: 7, height: 7)
        Text(title(state))
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(tint)
          .lineLimit(1)
        if state == .degraded {
          Button(ArkL10n.text(.connectionReconnectNow, model.languagePreference)) {
            model.reconnectEventsNow()
          }
          .disabled(model.isReconnectingEvents)
          .buttonStyle(.plain)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ArkPalette.secondary)
          .accessibilityIdentifier("ark.session.reconnect-now")
        }
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 4)
      .background(tint.opacity(0.14), in: Capsule())
      // 用 .contain 而不是 .combine：合并会吞掉「立即重连」按钮的元素身份，
      // UI 自动化与 VoiceOver 都将无法单独定位它。
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("ark.session.connection-status")
    }
  }
}
