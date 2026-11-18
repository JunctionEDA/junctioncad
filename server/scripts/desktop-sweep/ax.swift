import ApplicationServices
import Foundation
// usage: ax <pid> dump | press <title> | selectrow <text>
let pid = pid_t(CommandLine.arguments[1])!, cmd = CommandLine.arguments[2]
let arg = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : ""
let app = AXUIElementCreateApplication(pid)
func attr(_ e: AXUIElement, _ a: String) -> AnyObject? { var v: AnyObject?; AXUIElementCopyAttributeValue(e, a as CFString, &v); return v }
func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, "AXChildren") as? [AXUIElement]) ?? [] }
func label(_ e: AXUIElement) -> String { [attr(e,"AXRole"), attr(e,"AXTitle"), attr(e,"AXValue"), attr(e,"AXDescription")].map { ($0 as? String) ?? "" }.joined(separator: "|") }
func hasText(_ e: AXUIElement, _ t: String, _ d: Int = 0) -> Bool { if label(e).contains(t) { return true }; if d > 4 { return false }; return kids(e).contains { hasText($0, t, d+1) } }
func walk(_ e: AXUIElement, _ d: Int) {
  let l = label(e), role = (attr(e,"AXRole") as? String) ?? ""
  if cmd == "dump" { if d < 14 && (role.contains("Button") || role.contains("Window") || role.contains("Row") || role.contains("StaticText") || role.contains("Sheet")) { print(String(repeating: " ", count: d) + l) } }
  if cmd == "press" && role == "AXButton" && (attr(e,"AXTitle") as? String) == arg { print("press", AXUIElementPerformAction(e, "AXPress" as CFString).rawValue); exit(0) }
  if cmd == "selectrow" && role == "AXRow" && hasText(e, arg) { print("select", AXUIElementSetAttributeValue(e, "AXSelected" as CFString, kCFBooleanTrue).rawValue); exit(0) }
  for k in kids(e) { walk(k, d+1) }
}
walk(app, 0)
if cmd == "menu" {
  func findItem(_ e: AXUIElement, _ t: String, _ d: Int) -> AXUIElement? {
    for k in kids(e) { if ((attr(k,"AXTitle") as? String) ?? "").hasPrefix(t) { return k }; if d < 2, let r = findItem(k, t, d+1) { return r } }
    return nil
  }
  var cur = attr(app, "AXMenuBar") as! AXUIElement
  let parts = arg.components(separatedBy: ">")
  for (i, p) in parts.enumerated() {
    guard let it = findItem(cur, p, 0) else { print("no item", p); exit(1) }
    if i == parts.count - 1 { print("menu", AXUIElementPerformAction(it, "AXPress" as CFString).rawValue) }
    cur = it
  }
}
