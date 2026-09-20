import Foundation
import LexiconBarKit

/// Talks to `lexicon serve` (`POST /normalize`, `GET /health`) with the
/// bearer token from `~/.config/lexicon/serve.json`. The token file is read
/// lazily and re-read after any failure, so a `lexicon serve --uninstall &&
/// --install` (new token) heals on the next burst.
final class NormalizeClient: @unchecked Sendable {
    struct Credentials: Equatable {
        let port: Int
        let token: String
        var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }
    }

    enum Failure: Error, CustomStringConvertible {
        case noCredentials(String)
        case transport(String)
        case http(Int, String)
        case badBody

        var description: String {
            switch self {
            case .noCredentials(let path): return "serve.json not found at \(path); run `lexicon serve --install`."
            case .transport(let why): return "Local API unreachable: \(why)"
            case .http(let code, let body): return "Local API returned \(code)\(body.isEmpty ? "" : ": \(body)")"
            case .badBody: return "Local API returned an unexpected body."
            }
        }
    }

    let timeout: TimeInterval
    private let session: URLSession
    private let lock = NSLock()
    private var cached: Credentials?

    init(timeout: TimeInterval = 1.5) {
        self.timeout = timeout
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout + 0.5
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    /// `$LEXICON_PATH`'s directory, else `$XDG_CONFIG_HOME/lexicon`, else `~/.config/lexicon`.
    static var serveJSONPath: String {
        let env = ProcessInfo.processInfo.environment
        if let lexiconPath = env["LEXICON_PATH"], !lexiconPath.isEmpty {
            return (lexiconPath as NSString).deletingLastPathComponent + "/serve.json"
        }
        if let xdg = env["XDG_CONFIG_HOME"], !xdg.isEmpty {
            return xdg + "/lexicon/serve.json"
        }
        return FileManager.default.homeDirectoryForCurrentUser.path + "/.config/lexicon/serve.json"
    }

    static func readCredentials(path: String = serveJSONPath) -> Credentials? {
        guard let data = FileManager.default.contents(atPath: path),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let token = object["token"] as? String, !token.isEmpty else { return nil }
        let port = (object["port"] as? NSNumber)?.intValue ?? 41733
        return Credentials(port: port, token: token)
    }

    func credentials(reload: Bool = false) -> Credentials? {
        lock.lock(); defer { lock.unlock() }
        if !reload, let cached { return cached }
        cached = NormalizeClient.readCredentials()
        return cached
    }

    func invalidateCredentials() {
        lock.lock(); cached = nil; lock.unlock()
    }

    /// POST /normalize with `text`. Completion runs on an arbitrary queue.
    func normalize(_ text: String, completion: @escaping (Result<NormalizeResponse, Failure>) -> Void) {
        guard let creds = credentials() else {
            completion(.failure(.noCredentials(NormalizeClient.serveJSONPath)))
            return
        }
        var request = URLRequest(url: creds.baseURL.appendingPathComponent("normalize"))
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(creds.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["text": text])
        session.dataTask(with: request) { [weak self] data, response, error in
            if let error {
                self?.invalidateCredentials()
                completion(.failure(.transport(error.localizedDescription)))
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else {
                if status == 401 { self?.invalidateCredentials() }
                let body = data.map { String(decoding: $0.prefix(200), as: UTF8.self) } ?? ""
                completion(.failure(.http(status, body)))
                return
            }
            guard let data, let parsed = NormalizeResponse.parse(data) else {
                completion(.failure(.badBody))
                return
            }
            completion(.success(parsed))
        }.resume()
    }

    /// GET /health, synchronously (for `--status`). Returns the term count.
    func healthSync(timeout: TimeInterval = 2) -> Result<Int, Failure> {
        let port = credentials()?.port ?? 41733
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/health")!)
        request.timeoutInterval = timeout
        let done = DispatchSemaphore(value: 0)
        var outcome: Result<Int, Failure> = .failure(.transport("no response"))
        session.dataTask(with: request) { data, response, error in
            defer { done.signal() }
            if let error { outcome = .failure(.transport(error.localizedDescription)); return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200, let data,
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                outcome = .failure(.http(status, ""))
                return
            }
            outcome = .success((object["terms"] as? NSNumber)?.intValue ?? 0)
        }.resume()
        _ = done.wait(timeout: .now() + timeout + 1)
        return outcome
    }
}
