import AppKit
import ApplicationServices

/// One thread for every Accessibility call. Reads, writes and the AXObserver
/// run loop sources all live here, so they are serialized and a slow target
/// app never stalls the main thread. Blocks are queued with `async`.
final class AXThread: @unchecked Sendable {
    private let runLoop: CFRunLoop

    init() {
        final class Box: @unchecked Sendable { var loop: CFRunLoop? }
        let box = Box()
        let ready = DispatchSemaphore(value: 0)
        let thread = Thread {
            box.loop = CFRunLoopGetCurrent()
            // A port keeps the run loop alive while no observer source is attached.
            RunLoop.current.add(NSMachPort(), forMode: .default)
            ready.signal()
            while true {
                _ = RunLoop.current.run(mode: .default, before: .distantFuture)
            }
        }
        thread.name = "ai.ashlr.lexiconbar.ax"
        thread.qualityOfService = .userInteractive
        thread.start()
        ready.wait()
        runLoop = box.loop!
    }

    func async(_ block: @escaping () -> Void) {
        CFRunLoopPerformBlock(runLoop, CFRunLoopMode.defaultMode.rawValue, block)
        CFRunLoopWakeUp(runLoop)
    }

    func after(_ delay: TimeInterval, _ block: @escaping () -> Void) {
        DispatchQueue.global(qos: .userInteractive).asyncAfter(deadline: .now() + delay) { self.async(block) }
    }

    func add(_ source: CFRunLoopSource) {
        CFRunLoopAddSource(runLoop, source, .defaultMode)
        CFRunLoopWakeUp(runLoop)
    }

    func remove(_ source: CFRunLoopSource) {
        CFRunLoopRemoveSource(runLoop, source, .defaultMode)
    }
}

/// Thin wrappers over the AXUIElement C API. Every function here is expected
/// to run on the `AXThread`.
enum AX {
    static let textRoles: Set<String> = [kAXTextAreaRole as String, kAXTextFieldRole as String, kAXComboBoxRole as String]

    static func copy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard err == .success else { return nil }
        return value
    }

    static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        guard let value = copy(element, attribute) else { return nil }
        if CFGetTypeID(value) == CFStringGetTypeID() { return value as? String }
        if CFGetTypeID(value) == CFAttributedStringGetTypeID() { return (value as? NSAttributedString)?.string }
        return nil
    }

    static func element(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let value = copy(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(value, to: AXUIElement.self)
    }

    static func range(_ element: AXUIElement, _ attribute: String) -> NSRange? {
        guard let value = copy(element, attribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        let axValue = unsafeDowncast(value, to: AXValue.self)
        var cf = CFRange()
        guard AXValueGetType(axValue) == .cfRange, AXValueGetValue(axValue, .cfRange, &cf) else { return nil }
        return NSRange(location: cf.location, length: cf.length)
    }

    static func hasAttribute(_ element: AXUIElement, _ attribute: String) -> Bool {
        var names: CFArray?
        guard AXUIElementCopyAttributeNames(element, &names) == .success, let names = names as? [String] else { return false }
        return names.contains(attribute)
    }

    @discardableResult
    static func set(_ element: AXUIElement, _ attribute: String, string: String) -> AXError {
        AXUIElementSetAttributeValue(element, attribute as CFString, string as CFString)
    }

    @discardableResult
    static func set(_ element: AXUIElement, _ attribute: String, range: NSRange) -> AXError {
        var cf = CFRange(location: range.location, length: range.length)
        guard let value = AXValueCreate(.cfRange, &cf) else { return .failure }
        return AXUIElementSetAttributeValue(element, attribute as CFString, value)
    }

    @discardableResult
    static func set(_ element: AXUIElement, _ attribute: String, bool: Bool) -> AXError {
        AXUIElementSetAttributeValue(element, attribute as CFString, bool ? kCFBooleanTrue : kCFBooleanFalse)
    }

    static func pid(of element: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(element, &pid) == .success ? pid : nil
    }

    /// Stable-enough identity for "is this the same field": AXUIElementRef
    /// hashes by (pid, element token) inside one process.
    static func key(_ element: AXUIElement, pid: pid_t) -> String {
        "\(pid):\(CFHash(element))"
    }

    /// Text-like roles only. Secure fields are refused by subrole and by a
    /// role description containing "secure". Anything else counts when it
    /// exposes a string value plus a selected-text range (web and Electron
    /// editables show up that way).
    static func isEditableText(_ element: AXUIElement) -> Bool {
        let role = string(element, kAXRoleAttribute as String) ?? ""
        let subrole = string(element, kAXSubroleAttribute as String) ?? ""
        if subrole == (kAXSecureTextFieldSubrole as String) { return false }
        if let description = string(element, kAXRoleDescriptionAttribute as String),
           description.range(of: "secure", options: .caseInsensitive) != nil { return false }
        if let description = string(element, kAXRoleDescriptionAttribute as String),
           description.range(of: "password", options: .caseInsensitive) != nil { return false }
        if textRoles.contains(role) { return true }
        guard let value = copy(element, kAXValueAttribute as String), CFGetTypeID(value) == CFStringGetTypeID() else { return false }
        return hasAttribute(element, kAXSelectedTextRangeAttribute as String)
    }

    static func value(_ element: AXUIElement) -> String? {
        string(element, kAXValueAttribute as String)
    }

    static var isTrusted: Bool { AXIsProcessTrusted() }

    /// Shows the system "allow LexiconBar to control your computer" prompt if needed.
    @discardableResult
    static func requestTrust() -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }
}
