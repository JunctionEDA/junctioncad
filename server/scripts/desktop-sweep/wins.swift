import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments[1])!
let l = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in l where (w["kCGWindowOwnerPID"] as? Int) == pid {
  let b = w["kCGWindowBounds"] as? [String: Any] ?? [:]
  print(w["kCGWindowNumber"] ?? "", w["kCGWindowName"] ?? "", w["kCGWindowIsOnscreen"] ?? 0, b["Width"] ?? "", b["Height"] ?? "")
}
