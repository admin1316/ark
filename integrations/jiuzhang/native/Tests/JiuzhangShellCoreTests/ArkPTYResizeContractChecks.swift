import Foundation
@testable import JiuzhangShellUI

/// PTY 窗口尺寸契约：TIOCSWINSZ 即使字符网格未变也会向 shell 发 SIGWINCH，
/// 而登录 shell 每收到一次就重绘一行提示符 —— 分栏拖拽/窗口动画的连续布局回调
/// 因此会把终端刷成一片空提示符。这里锁住「仅在网格真的变化时才下发」这一条规则。
func runArkPTYResizeContractChecks() {
  typealias Grid = (columns: Int, rows: Int)
  func appliedGrid(_ columns: Int, _ rows: Int, _ last: Grid?) -> Grid? {
    NativePTYTerminalSession.windowSizeIfNeeded(columns: columns, rows: rows, lastApplied: last)
  }

  // 1) 首次应用：无历史值 → 下发
  let first: Grid? = appliedGrid(100, 30, nil)
  check(first?.columns == 100 && first?.rows == 30, "first applied grid is pushed to the PTY")

  // 2) 同一网格重复回调 → 不下发（刷屏回归锁）
  let baseline: Grid = (columns: 100, rows: 30)
  let sameAgain: Grid? = appliedGrid(100, 30, baseline)
  check(sameAgain == nil, "an unchanged grid never re-signals the shell")

  // 3) 真的变化才下发，且下发后成为新的去重基线
  let changed: Grid? = appliedGrid(100, 31, baseline)
  check(changed?.rows == 31, "a genuinely different grid is applied")
  let repeatChanged: Grid? = appliedGrid(100, 31, changed)
  check(repeatChanged == nil, "the new grid becomes the dedupe baseline once applied")

  // 4) 越界钳制仍然生效，且钳制后相等同样不下发
  let floored: Grid? = appliedGrid(0, -5, nil)
  check(floored?.columns == 2 && floored?.rows == 2, "degenerate sizes clamp to the minimum grid")
  let refloored: Grid? = appliedGrid(1, 1, floored)
  check(refloored == nil, "values that clamp onto the applied grid do not re-signal")
  let ceiling = Int(UInt16.max)
  let capped: Grid? = appliedGrid(ceiling + 500, ceiling + 1, nil)
  check(capped?.columns == ceiling && capped?.rows == ceiling, "oversized grids clamp to the winsize ceiling")
}
