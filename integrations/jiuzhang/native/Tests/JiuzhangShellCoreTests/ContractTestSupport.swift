import Foundation

/// 契约测试共享支持：native 包根路径。
/// 由独立文件提供，避免把公共基础设施隐式挂到某个检查文件上。
let contractNativeRoot = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .deletingLastPathComponent()
  .deletingLastPathComponent()
