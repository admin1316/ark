import Foundation

/// 配置写入的 single-flight + latest-intent 合并器（纯值类型，契约测试可直接验证）。
/// 供 ui-theme 与 locale 等「控件原地显示状态」的配置切换共用。
///
/// 语义：
/// - `intent(_:)` 记录最新意图，后到的覆盖先到的（coalescing）；
/// - `begin()` 仅在无在飞写且有 pending 时取走它并置在飞；否则返回 nil——
///   调用方因此绝不并发提交第二个同 namespace mutation；
/// - `takePending()` 取走写入期间新到达的意图，不改变在飞状态；
/// - `finish()` 结束在飞。
///
/// 全部方法须在 MainActor 上调用；退出 drain 循环到 `finish()` 之间不得插入
/// await，否则在飞标志与 pending 之间会出现悬浮窗口。
public struct ArkSingleFlightLatestGate: Equatable, Sendable {
  public private(set) var inFlight = false
  public private(set) var pending: String?

  public init() {}

  public mutating func intent(_ preference: String) {
    pending = preference
  }

  public mutating func begin() -> String? {
    guard !inFlight, let next = pending else { return nil }
    pending = nil
    inFlight = true
    return next
  }

  public mutating func takePending() -> String? {
    let next = pending
    pending = nil
    return next
  }

  public mutating func finish() {
    inFlight = false
  }
}
