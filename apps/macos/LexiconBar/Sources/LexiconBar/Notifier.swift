import Foundation
@preconcurrency import UserNotifications

/// Posts "Corrected 2 words" style notifications. UNUserNotificationCenter
/// only works from a real .app bundle (it aborts in a bare `swift build`
/// binary), so everything is a no-op when unbundled. Permission is requested
/// on first use; denial degrades silently.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let isBundled: Bool = {
        Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app"
    }()

    private var granted: Bool?
    private var requesting = false
    private var pending: [(String, String)] = []

    override init() {
        super.init()
        guard Notifier.isBundled else { return }
        UNUserNotificationCenter.current().delegate = self
    }

    func post(title: String, body: String) {
        guard Notifier.isBundled else { return }
        switch granted {
        case .some(true):
            deliver(title: title, body: body)
        case .some(false):
            return
        case .none:
            pending.append((title, body))
            requestIfNeeded()
        }
    }

    private func requestIfNeeded() {
        guard !requesting else { return }
        requesting = true
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            let decide: @MainActor (Bool) -> Void = { ok in
                self.granted = ok
                self.requesting = false
                let queued = self.pending
                self.pending = []
                if ok { queued.forEach { self.deliver(title: $0.0, body: $0.1) } }
            }
            switch settings.authorizationStatus {
            case .authorized, .provisional:
                DispatchQueue.main.async { decide(true) }
            case .denied:
                DispatchQueue.main.async { decide(false) }
            default:
                center.requestAuthorization(options: [.alert, .sound]) { ok, _ in
                    DispatchQueue.main.async { decide(ok) }
                }
            }
        }
    }

    private func deliver(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error { NSLog("LexiconBar: notification failed: %@", error.localizedDescription) }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
