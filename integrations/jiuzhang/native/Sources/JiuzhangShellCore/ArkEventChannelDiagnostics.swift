import Foundation
import os

/// Privacy-safe journal for the two native event downlinks. It records only channel state,
/// generation/baseline movement, sequence gaps, heal outcomes and client backlog — never message
/// content — so a stream incident can be reconstructed after the fact with:
/// `log show --last 1h --predicate 'subsystem == "cn.jiuzhangtianmu.industrybrain.ark.events"'`.
public enum ArkEventChannelDiagnostics {
  /// Unified-log subsystem shared by every recorded line.
  public static let subsystem = "cn.jiuzhangtianmu.industrybrain.ark.events"
  private static let downlink = Logger(subsystem: subsystem, category: "downlink")
  private static let sequence = Logger(subsystem: subsystem, category: "sequence")
  private static let pacing = Logger(subsystem: subsystem, category: "pacing")

  /// Record one downlink state change.
  public static func connection(channel: String, state: String) {
    downlink.notice("channel=\(channel, privacy: .public) state=\(state, privacy: .public)")
  }

  /// Record one downlink failure code (never the raw transport message).
  public static func failure(channel: String, code: String) {
    downlink.warning("channel=\(channel, privacy: .public) failure=\(code, privacy: .public)")
  }

  /// Record one stream baseline phase.
  public static func baseline(generation: String, phase: String, sessionCount: Int) {
    downlink.info("generation=\(generation, privacy: .public) phase=\(phase, privacy: .public) sessions=\(sessionCount)")
  }

  /// Record the mux baseline for the displayed Session next to the local anchor.
  public static func subscribed(session: String, baseline: Int, anchor: Int, target: Int?) {
    sequence.notice("session=\(session, privacy: .public) baseline=\(baseline) anchor=\(anchor) target=\(target ?? -1)")
  }

  /// Record a detected hole: the anchor never moves for a gap, the range is paged in instead.
  public static func gap(session: String, expected: Int, actual: Int) {
    sequence.warning("session=\(session, privacy: .public) gap expected=\(expected) actual=\(actual)")
  }

  /// Record one reconciliation result (a heal installs a contiguous head at or above its target).
  public static func reconciled(session: String, head: Int, target: Int?) {
    sequence.notice("session=\(session, privacy: .public) head=\(head) target=\(target ?? -1)")
  }

  /// Record a publish that carried a large batch or took long enough to matter.
  public static func publish(added: Int, backlog: Int, milliseconds: Int) {
    pacing.info("added=\(added) backlog=\(backlog) ms=\(milliseconds)")
  }

  /// Record receive-loop back pressure: the consumer stopped draining, so the socket stopped
  /// draining too and the Host's bounded queue is the next thing to overflow.
  public static func backpressure(channel: String, buffered: Int, suspended: Int) {
    downlink.warning("channel=\(channel, privacy: .public) buffered=\(buffered) suspended=\(suspended)")
  }
}
