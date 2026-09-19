import AppKit
import Carbon.HIToolbox
import LexiconBarKit

/// Registers global hotkeys with Carbon's `RegisterEventHotKey`. This works
/// without Accessibility permission (unlike CGEvent taps). One shared Carbon
/// event handler dispatches by hotkey id to the registered closures.
@MainActor
final class HotKeyCenter {
    private struct Registration {
        let ref: EventHotKeyRef
        let action: () -> Void
    }

    private var registrations: [UInt32: Registration] = [:]
    private var handlerRef: EventHandlerRef?
    private var nextID: UInt32 = 1
    private static let signature: OSType = 0x4C58_4252 // "LXBR"

    init() {
        installHandler()
    }

    deinit {
        if let handlerRef { RemoveEventHandler(handlerRef) }
    }

    private func installHandler() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let selfPointer = Unmanaged.passUnretained(self).toOpaque()
        let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, userData -> OSStatus in
            guard let event, let userData else { return OSStatus(eventNotHandledErr) }
            var hotKeyID = EventHotKeyID()
            let err = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                        nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
            guard err == noErr else { return err }
            let center = Unmanaged<HotKeyCenter>.fromOpaque(userData).takeUnretainedValue()
            let id = hotKeyID.id
            DispatchQueue.main.async { center.fire(id: id) }
            return noErr
        }, 1, &spec, selfPointer, &handlerRef)
        if status != noErr {
            NSLog("LexiconBar: InstallEventHandler failed (%d)", status)
        }
    }

    private func fire(id: UInt32) {
        registrations[id]?.action()
    }

    /// Registers `hotKey`; returns an id for `unregister`, or nil if the system
    /// refused (usually because another app owns the combination).
    @discardableResult
    func register(_ hotKey: HotKey, action: @escaping () -> Void) -> UInt32? {
        guard hotKey.isValid else { return nil }
        let id = nextID
        nextID += 1
        var ref: EventHotKeyRef?
        let hotKeyID = EventHotKeyID(signature: HotKeyCenter.signature, id: id)
        let status = RegisterEventHotKey(hotKey.keyCode, hotKey.modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else {
            NSLog("LexiconBar: RegisterEventHotKey %@ failed (%d)", hotKey.displayString, status)
            return nil
        }
        registrations[id] = Registration(ref: ref, action: action)
        return id
    }

    func unregister(_ id: UInt32) {
        guard let reg = registrations.removeValue(forKey: id) else { return }
        UnregisterEventHotKey(reg.ref)
    }

    func unregisterAll() {
        for id in Array(registrations.keys) { unregister(id) }
    }
}
