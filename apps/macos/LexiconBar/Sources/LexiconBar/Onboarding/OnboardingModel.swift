import AppKit
import Combine
import LexiconBarKit

/// State behind the first-run window. Every network call goes out on
/// `LocalAPI`'s background session and hops back to main here, so the window
/// never blocks while `GET /aliases` or a pack install is in flight.
@MainActor
final class OnboardingModel: ObservableObject {
    /// How long after the last keystroke the alias suggestions are fetched.
    static let aliasDebounce: TimeInterval = 0.5
    /// How long after the last keystroke the Try-it box re-normalizes.
    static let tryItDebounce: TimeInterval = 0.3

    // MARK: shared

    @Published private(set) var flow = OnboardingFlow()
    let settings: Settings

    // MARK: step 1, welcome

    @Published private(set) var accessibilityTrusted = AX.isTrusted
    /// nil while the first check is in flight.
    @Published private(set) var apiReachable: Bool?
    @Published private(set) var apiTerms = 0

    // MARK: step 2, your words

    @Published var drafts: [TermDraft] = []
    @Published var tryItText = ""
    @Published private(set) var tryItOutput: String?
    @Published private(set) var tryItReplacements: [Replacement] = []
    @Published private(set) var tryItBusy = false
    @Published private(set) var lastError: String?
    /// Canonicals successfully written with `POST /add`, in the order added.
    @Published private(set) var savedTerms: [String] = []

    // MARK: step 3, packs

    @Published private(set) var packs: [LocalAPI.Pack] = []
    @Published private(set) var packSelection = PackSelection()
    @Published private(set) var packsLoading = false
    @Published private(set) var packsError: String?
    /// "70 terms added" per pack name, after a successful install.
    @Published private(set) var packSummaries: [String: String] = [:]

    // MARK: step 5, done

    @Published private(set) var summaryTerms = 0
    @Published private(set) var summaryAliases = 0

    /// Opens the global lexicon file; supplied by the app delegate so the
    /// window does not need its own CLI runner.
    var openLexiconFile: (() -> Void)?
    /// Called when the window reaches the end, so the delegate can set `didOnboard`.
    var onFinish: (() -> Void)?

    private let api: LocalAPI
    private var aliasWork: [UUID: DispatchWorkItem] = [:]
    private var tryItWork: DispatchWorkItem?
    private var statusTimer: Timer?

    /// Every call that writes the lexicon file queues here and runs strictly
    /// one at a time.
    ///
    /// `POST /add` and `POST`/`DELETE /packs/:name` are each a
    /// read-modify-write of the same YAML on the server, so two in flight
    /// together race and the last write wins. Seen live: the three default
    /// packs installed at once left exactly one of them listed. Reads
    /// (`/aliases`, `/normalize`, `/stats`) are not queued - they are
    /// harmless in parallel and the window should stay responsive.
    private var writeQueue: [(@escaping () -> Void) -> Void] = []
    private var writeRunning = false

    init(settings: Settings, api: LocalAPI) {
        self.settings = settings
        self.api = api
        drafts = OnboardingModel.seedDrafts()
        tryItText = OnboardingModel.sampleSentence(fullName: NSFullUserName())
    }

    /// One row pre-filled with the macOS full name (the single term almost
    /// every user needs) and one blank row. The company is deliberately not
    /// guessed: a wrong canonical is worse than an empty field, because the
    /// user would have to notice and delete it.
    static func seedDrafts() -> [TermDraft] {
        let name = NSFullUserName().trimmingCharacters(in: .whitespacesAndNewlines)
        let seeded = name.isEmpty || name.lowercased() == NSUserName().lowercased() ? "" : name
        return [TermDraft(canonical: seeded), TermDraft()]
    }

    /// The sentence the Try-it box starts with, so the payoff is visible
    /// before the user types anything.
    static func sampleSentence(fullName: String) -> String {
        let name = fullName.trimmingCharacters(in: .whitespacesAndNewlines)
        let subject = name.isEmpty ? "me" : name
        return "ping \(subject) about the cooper netties rollout on versel"
    }

    // MARK: navigation

    func next() {
        saveReadyDrafts()
        flow.next()
        entered(flow.step)
    }

    func back() {
        flow.back()
        entered(flow.step)
    }

    func skip() {
        flow.skip()
        entered(flow.step)
    }

    func skipToEnd() {
        flow.skipToEnd()
        entered(flow.step)
    }

    func go(to step: OnboardingStep) {
        saveReadyDrafts()
        flow.go(to: step)
        entered(flow.step)
    }

    /// Kicks off whatever a step needs the moment it appears.
    func entered(_ step: OnboardingStep) {
        switch step {
        case .welcome:
            refreshStatus()
            startStatusPolling()
        case .words:
            stopStatusPolling()
            refreshTryIt()
            for draft in drafts where draft.needsSuggestions { fetchSuggestions(for: draft.id) }
        case .packs:
            stopStatusPolling()
            loadPacks()
        case .whereItWorks:
            stopStatusPolling()
            refreshTryIt()
        case .done:
            stopStatusPolling()
            refreshSummary()
            onFinish?()
        }
    }

    // MARK: step 1

    func refreshStatus() {
        accessibilityTrusted = AX.isTrusted
        api.health { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let terms):
                    self.apiReachable = true
                    self.apiTerms = terms
                case .failure:
                    self.apiReachable = false
                }
            }
        }
    }

    /// While the welcome step is up, keep checking: the user is expected to
    /// leave for System Settings and come back, and the line should have
    /// caught up by the time they do.
    private func startStatusPolling() {
        guard statusTimer == nil else { return }
        statusTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            DispatchQueue.main.async { self?.refreshStatus() }
        }
    }

    private func stopStatusPolling() {
        statusTimer?.invalidate()
        statusTimer = nil
    }

    func grantAccessibility() {
        AX.requestTrust()
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    /// The "Start the API" button: flips the setting, which the app delegate
    /// observes and turns into a `lexicon serve` child process.
    func startLocalAPI() {
        settings.localAPI = true
        // The child needs a moment to bind the port.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.refreshStatus() }
    }

    // MARK: step 2

    func addDraft() {
        drafts.append(TermDraft())
    }

    func removeDraft(_ id: UUID) {
        aliasWork[id]?.cancel()
        aliasWork[id] = nil
        drafts.removeAll { $0.id == id }
        if drafts.isEmpty { drafts = [TermDraft()] }
    }

    /// Called on every keystroke in a canonical field.
    func canonicalChanged(_ id: UUID, to value: String) {
        guard let index = drafts.firstIndex(where: { $0.id == id }) else { return }
        drafts[index].canonicalChanged(to: value)
        scheduleSuggestions(for: id)
    }

    /// Debounced `GET /aliases`. Leaving the field (`commitDraft`) asks
    /// immediately instead of waiting out the rest of the debounce.
    private func scheduleSuggestions(for id: UUID) {
        aliasWork[id]?.cancel()
        guard let index = drafts.firstIndex(where: { $0.id == id }), drafts[index].needsSuggestions else { return }
        let work = DispatchWorkItem { [weak self] in self?.fetchSuggestions(for: id) }
        aliasWork[id] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.aliasDebounce, execute: work)
    }

    func fetchSuggestions(for id: UUID) {
        aliasWork[id]?.cancel()
        aliasWork[id] = nil
        guard let index = drafts.firstIndex(where: { $0.id == id }), drafts[index].needsSuggestions else { return }
        let canonical = drafts[index].trimmedCanonical
        drafts[index].isLoadingSuggestions = true
        api.aliases(for: canonical) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, let index = self.drafts.firstIndex(where: { $0.id == id }) else { return }
                // The user may have typed on; only apply to the canonical asked for.
                guard self.drafts[index].trimmedCanonical.caseInsensitiveCompare(canonical) == .orderedSame else {
                    self.drafts[index].isLoadingSuggestions = false
                    return
                }
                switch result {
                case .success(let aliases):
                    self.drafts[index].applySuggestions(aliases, for: canonical)
                case .failure(let why):
                    self.drafts[index].isLoadingSuggestions = false
                    self.lastError = why.description
                }
            }
        }
    }

    func toggleChip(_ id: UUID, chip: String) {
        guard let index = drafts.firstIndex(where: { $0.id == id }) else { return }
        drafts[index].toggle(chip)
    }

    func addCustomAlias(_ id: UUID, alias: String) {
        guard let index = drafts.firstIndex(where: { $0.id == id }) else { return }
        drafts[index].addCustom(alias)
    }

    /// Field blur or Return: fetch suggestions now, then write the term.
    func commitDraft(_ id: UUID) {
        guard let index = drafts.firstIndex(where: { $0.id == id }), drafts[index].isReady else { return }
        if drafts[index].needsSuggestions {
            fetchSuggestions(for: id)
            return
        }
        save(draftAt: index)
    }

    /// Writes every row that has a canonical and has not been written yet.
    /// Called on Continue so a row the user never left still lands.
    func saveReadyDrafts() {
        for index in drafts.indices where drafts[index].isReady && !drafts[index].submitted {
            save(draftAt: index)
        }
    }

    private func save(draftAt index: Int) {
        guard drafts.indices.contains(index) else { return }
        let draft = drafts[index]
        guard draft.isReady, !draft.submitted else { return }
        let id = draft.id
        let canonical = draft.trimmedCanonical
        let aliases = draft.selectedAliases
        drafts[index].submitted = true
        enqueueWrite { [weak self] done in
            guard let self else { done(); return }
            self.api.add(canonical: canonical, aliases: aliases) { result in
                DispatchQueue.main.async {
                    switch result {
                    case .success(let added):
                        if !self.savedTerms.contains(added.canonical) { self.savedTerms.append(added.canonical) }
                        self.lastError = nil
                        // A new term changes the answer, so the Try-it box is stale.
                        self.refreshTryIt()
                    case .failure(let why):
                        // Let the user try again rather than silently losing the row.
                        if let index = self.drafts.firstIndex(where: { $0.id == id }) {
                            self.drafts[index].submitted = false
                        }
                        self.lastError = why.description
                    }
                    done()
                }
            }
        }
    }

    // MARK: the Try-it box

    /// Debounced `POST /normalize` on whatever is in the box.
    func tryItChanged(_ text: String) {
        tryItText = text
        tryItWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.refreshTryIt() }
        tryItWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.tryItDebounce, execute: work)
    }

    func refreshTryIt() {
        tryItWork?.cancel()
        tryItWork = nil
        let text = tryItText
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            tryItOutput = nil
            tryItReplacements = []
            return
        }
        tryItBusy = true
        api.normalize(text) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.tryItBusy = false
                // Ignore an answer to a sentence the user has already changed.
                guard self.tryItText == text else { return }
                switch result {
                case .success(let response):
                    self.tryItOutput = response.output
                    self.tryItReplacements = response.replacements.map(\.asReplacement)
                case .failure(let why):
                    self.tryItOutput = nil
                    self.tryItReplacements = []
                    self.lastError = why.description
                }
            }
        }
    }

    /// Ranges of the canonical spellings inside the corrected sentence, so
    /// the view can bold exactly what changed.
    ///
    /// The API reports offsets into the *input*, which do not survive the
    /// rewrite, so each canonical is instead found in the output walking
    /// forwards from the end of the previous one. Replacements arrive in
    /// input order, so that keeps two occurrences of the same canonical apart.
    static func highlightRanges(in output: String, replacements: [Replacement]) -> [Range<String.Index>] {
        var ranges: [Range<String.Index>] = []
        var cursor = output.startIndex
        for replacement in replacements {
            guard !replacement.replacement.isEmpty,
                  let found = output.range(of: replacement.replacement, range: cursor..<output.endIndex)
            else { continue }
            ranges.append(found)
            cursor = found.upperBound
        }
        return ranges
    }

    // MARK: step 3

    func loadPacks() {
        guard packs.isEmpty else { return }
        packsLoading = true
        packsError = nil
        api.packs { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.packsLoading = false
                switch result {
                case .success(let packs):
                    self.packs = packs
                    self.packSelection.reconcile(with: packs.filter(\.installed).map(\.name))
                    self.installDefaultsIfFresh()
                case .failure(let why):
                    self.packsError = why.description
                }
            }
        }
    }

    /// On a lexicon with no packs at all, the three recommended ones are
    /// switched on for the user (each card shows what it added). A lexicon
    /// that already lists packs is left exactly as it is.
    private func installDefaultsIfFresh() {
        guard packSelection.installed.isEmpty else { return }
        for name in packs.map(\.name) where PackSelection.defaults.contains(name) {
            togglePack(name)
        }
    }

    /// Flips a pack's card at once and queues the write behind any other.
    func togglePack(_ name: String) {
        guard !packSelection.isBusy(name) else { return }
        let wantInstalled = packSelection.beginToggle(name)
        enqueueWrite { [weak self] done in
            guard let self else { done(); return }
            let settle: (Bool) -> Void = { ok in
                self.packSelection.endToggle(name, succeeded: ok, wantedInstalled: wantInstalled)
                done()
            }
            if wantInstalled {
                self.api.installPack(name) { result in
                    DispatchQueue.main.async {
                        switch result {
                        case .success(let install):
                            self.packSummaries[name] = install.summary
                            self.packsError = nil
                            settle(true)
                        case .failure(let why):
                            self.packsError = why.description
                            settle(false)
                        }
                    }
                }
            } else {
                self.api.uninstallPack(name) { result in
                    DispatchQueue.main.async {
                        switch result {
                        case .success(let removed):
                            self.packSummaries[name] = removed.isEmpty ? nil : "\(removed.count) removed"
                            self.packsError = nil
                            settle(true)
                        case .failure(let why):
                            self.packsError = why.description
                            settle(false)
                        }
                    }
                }
            }
        }
    }

    // MARK: the serial write queue

    /// `work` is handed a `done` closure it must call exactly once, on the
    /// main thread, when its request has settled.
    private func enqueueWrite(_ work: @escaping (@escaping () -> Void) -> Void) {
        writeQueue.append(work)
        pumpWrites()
    }

    private func pumpWrites() {
        guard !writeRunning, !writeQueue.isEmpty else { return }
        writeRunning = true
        let work = writeQueue.removeFirst()
        var finished = false
        work { [weak self] in
            guard !finished else { return }
            finished = true
            guard let self else { return }
            self.writeRunning = false
            self.pumpWrites()
        }
    }

    // MARK: step 5

    func refreshSummary() {
        api.stats { [weak self] result in
            DispatchQueue.main.async {
                guard let self, case .success(let stats) = result else { return }
                self.summaryTerms = stats.terms
                self.summaryAliases = stats.aliases
            }
        }
    }

    /// "Fix everywhere, the clipboard watcher and the login service" for the
    /// Done step, in the user's own words.
    var enabledSummary: [String] {
        var lines: [String] = []
        lines.append(settings.fixEverywhere ? "Fix everywhere is on" : "Fix everywhere is off")
        if settings.watchClipboard { lines.append("The clipboard watcher is running") }
        if settings.localAPI { lines.append("The local API starts with the app") }
        if settings.showBubble { lines.append("The correction bubble shows for \(Int(settings.bubbleSeconds)) s") }
        return lines
    }

    deinit {
        statusTimer?.invalidate()
    }
}
