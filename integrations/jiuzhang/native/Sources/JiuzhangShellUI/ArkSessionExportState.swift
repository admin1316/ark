import Foundation

public enum ArkSessionExportState: Equatable, Sendable {
  case idle
  case exporting
  case succeeded(bytes: UInt64)
  case failed(message: String)
}
