import Foundation
import LexiconBarKit

/// The rest of `lexicon serve` that the onboarding window and the correction
/// bubble need: `/aliases`, `/add`, `/learn`, `/packs`, `/stats`, `/normalize`.
///
/// Credentials come from `NormalizeClient` (one loader, one cache, one
/// invalidation path), so a `lexicon serve --uninstall && --install` heals
/// here too. Every completion runs on a background queue; callers hop to main.
///
/// The timeout is longer than `NormalizeClient`'s 1.5 s because these calls
/// write YAML rather than answering from memory: installing a 70-term pack
/// reads a file, merges and writes it back.
final class LocalAPI: @unchecked Sendable {
    typealias Failure = NormalizeClient.Failure

    /// One row of `GET /packs`.
    struct Pack: Equatable, Identifiable, Sendable {
        let name: String
        let title: String
        let description: String
        /// Term count in the pack file.
        let terms: Int
        /// Alias count across those terms.
        let aliases: Int
        let installed: Bool

        var id: String { name }
    }

    /// `POST /packs/:name`.
    struct PackInstall: Equatable, Sendable {
        /// Terms created.
        let added: Int
        /// Terms that already existed and only gained aliases.
        let merged: Int
        /// What the card shows: "70 terms added".
        var summary: String {
            let total = added + merged
            let unit = total == 1 ? "term" : "terms"
            if merged > 0, added > 0 { return "\(added) \(unit) added, \(merged) merged" }
            if added == 0, merged > 0 { return "\(merged) \(merged == 1 ? "term" : "terms") merged" }
            return "\(added) \(added == 1 ? "term" : "terms") added"
        }
    }

    /// `POST /add`.
    struct AddResult: Equatable, Sendable {
        let canonical: String
        /// False when the canonical already existed and only gained aliases.
        let created: Bool
        /// The lexicon file that was written.
        let path: String
    }

    private let credentialSource: NormalizeClient
    private let session: URLSession
    let timeout: TimeInterval

    init(credentials: NormalizeClient, timeout: TimeInterval = 8) {
        self.credentialSource = credentials
        self.timeout = timeout
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout + 1
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    // MARK: requests

    /// `GET /aliases?canonical=X` -> the STT misspellings the CLI would guess.
    func aliases(for canonical: String, completion: @escaping (Result<[String], Failure>) -> Void) {
        var components = URLComponents(string: "/aliases")!
        components.queryItems = [URLQueryItem(name: "canonical", value: canonical)]
        send("GET", path: components.string ?? "/aliases") { result in
            completion(result.flatMap { object in
                guard let aliases = object["aliases"] as? [String] else { return .failure(.badBody) }
                return .success(aliases)
            })
        }
    }

    /// `POST /add`. `aliases` nil lets the server pick its own suggestions;
    /// an explicit empty array would mean the same thing, so the two are equal
    /// here. `never` records a spelling the user said must be left alone.
    func add(canonical: String, aliases: [String]? = nil, never: [String]? = nil,
             completion: @escaping (Result<AddResult, Failure>) -> Void) {
        var body: [String: Any] = ["canonical": canonical]
        if let aliases, !aliases.isEmpty { body["aliases"] = aliases }
        if let never, !never.isEmpty { body["never"] = never }
        send("POST", path: "/add", body: body) { result in
            completion(result.flatMap { object in
                let term = object["term"] as? [String: Any]
                let name = (term?["canonical"] as? String) ?? canonical
                return .success(AddResult(canonical: name,
                                          created: (object["created"] as? Bool) ?? false,
                                          path: (object["path"] as? String) ?? ""))
            })
        }
    }

    /// `POST /learn` - promotes what dictation wrote to an explicit alias.
    func learn(heard: String, meant: String, completion: @escaping (Result<Bool, Failure>) -> Void) {
        send("POST", path: "/learn", body: ["heard": heard, "meant": meant]) { result in
            completion(result.map { ($0["aliasAdded"] as? Bool) ?? false })
        }
    }

    /// `GET /packs` - every shipped pack with whether this lexicon lists it.
    func packs(completion: @escaping (Result<[Pack], Failure>) -> Void) {
        send("GET", path: "/packs") { result in
            completion(result.flatMap { object in
                guard let rows = object["packs"] as? [[String: Any]] else { return .failure(.badBody) }
                let packs: [Pack] = rows.compactMap { row in
                    guard let name = row["name"] as? String else { return nil }
                    return Pack(name: name,
                                title: (row["title"] as? String) ?? name,
                                description: (row["description"] as? String) ?? "",
                                terms: (row["terms"] as? NSNumber)?.intValue ?? 0,
                                aliases: (row["aliases"] as? NSNumber)?.intValue ?? 0,
                                installed: (row["installed"] as? Bool) ?? false)
                }
                return .success(packs)
            })
        }
    }

    /// `POST /packs/:name`.
    func installPack(_ name: String, completion: @escaping (Result<PackInstall, Failure>) -> Void) {
        send("POST", path: "/packs/\(name)", body: [:]) { result in
            completion(result.map {
                PackInstall(added: ($0["added"] as? NSNumber)?.intValue ?? 0,
                            merged: ($0["merged"] as? NSNumber)?.intValue ?? 0)
            })
        }
    }

    /// `DELETE /packs/:name`. Options travel in the query string, not a body.
    /// Returns the canonicals removed; terms the user edited are kept and are
    /// not in that list.
    func uninstallPack(_ name: String, completion: @escaping (Result<[String], Failure>) -> Void) {
        send("DELETE", path: "/packs/\(name)") { result in
            completion(result.map { ($0["removed"] as? [String]) ?? [] })
        }
    }

    /// `POST /normalize` with a generous timeout, for the onboarding Try-it box.
    func normalize(_ text: String, completion: @escaping (Result<NormalizeResponse, Failure>) -> Void) {
        sendRaw("POST", path: "/normalize", body: ["text": text]) { result in
            completion(result.flatMap { data in
                guard let parsed = NormalizeResponse.parse(data) else { return .failure(.badBody) }
                return .success(parsed)
            })
        }
    }

    /// `GET /stats` -> (terms, aliases), for the Done summary.
    func stats(completion: @escaping (Result<(terms: Int, aliases: Int), Failure>) -> Void) {
        send("GET", path: "/stats") { result in
            completion(result.map {
                (terms: ($0["termCount"] as? NSNumber)?.intValue ?? 0,
                 aliases: ($0["aliasCount"] as? NSNumber)?.intValue ?? 0)
            })
        }
    }

    /// `GET /health` - no bearer needed, so this also answers "is it running".
    func health(completion: @escaping (Result<Int, Failure>) -> Void) {
        send("GET", path: "/health") { result in
            completion(result.map { ($0["terms"] as? NSNumber)?.intValue ?? 0 })
        }
    }

    // MARK: transport

    private func send(_ method: String, path: String, body: [String: Any]? = nil,
                      completion: @escaping (Result<[String: Any], Failure>) -> Void) {
        sendRaw(method, path: path, body: body) { result in
            completion(result.flatMap { data in
                guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                    return .failure(.badBody)
                }
                return .success(object)
            })
        }
    }

    private func sendRaw(_ method: String, path: String, body: [String: Any]? = nil,
                         completion: @escaping (Result<Data, Failure>) -> Void) {
        guard let creds = credentialSource.credentials() else {
            completion(.failure(.noCredentials(NormalizeClient.serveJSONPath)))
            return
        }
        guard let url = URL(string: creds.baseURL.absoluteString + path) else {
            completion(.failure(.transport("bad path \(path)")))
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("Bearer \(creds.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        session.dataTask(with: request) { [weak self] data, response, error in
            if let error {
                self?.credentialSource.invalidateCredentials()
                completion(.failure(.transport(error.localizedDescription)))
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                if status == 401 { self?.credentialSource.invalidateCredentials() }
                // The server always answers `{"error": "..."}`; show that rather than raw JSON.
                let message: String
                if let data, let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                   let error = object["error"] as? String {
                    message = error
                } else {
                    message = data.map { String(decoding: $0.prefix(200), as: UTF8.self) } ?? ""
                }
                completion(.failure(.http(status, message)))
                return
            }
            guard let data else { completion(.failure(.badBody)); return }
            completion(.success(data))
        }.resume()
    }
}
