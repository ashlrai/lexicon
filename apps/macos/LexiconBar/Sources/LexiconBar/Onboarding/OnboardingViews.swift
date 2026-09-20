import SwiftUI
import LexiconBarKit

/// The first-run window: five steps, one per screen, with Back/Continue and a
/// row of progress dots. Everything here is layout; the state and the network
/// calls live in `OnboardingModel`.
struct OnboardingView: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                step
                    .padding(.horizontal, 28)
                    .padding(.vertical, 20)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: .infinity)
            Divider()
            footer
        }
        .frame(minWidth: 640, minHeight: 560)
        .onAppear { model.entered(model.flow.step) }
    }

    // MARK: chrome

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: model.flow.step.symbol)
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(.tint)
                .frame(width: 30)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.flow.step.title).font(.headline)
                Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 16)
    }

    private var subtitle: String {
        switch model.flow.step {
        case .welcome: return "What Lexicon does, and what it needs from you."
        case .words: return "The names dictation gets wrong. This is the part that matters."
        case .packs: return "Vocabulary someone already wrote down for you."
        case .whereItWorks: return "Where corrections happen, and how to reach them."
        case .done: return "You are set up."
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Button("Back") { model.back() }
                .disabled(model.flow.isFirst)
                .keyboardShortcut("[", modifiers: .command)

            Spacer()

            ProgressDots(flow: model.flow) { model.go(to: $0) }

            Spacer()

            if !model.flow.isLast {
                Button("Skip") { model.skip() }
                    .buttonStyle(.link)
                Button("Continue") { model.next() }
                    .keyboardShortcut(.defaultAction)
            } else {
                Button("Close") { NSApp.keyWindow?.performClose(nil) }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 14)
    }

    @ViewBuilder
    private var step: some View {
        switch model.flow.step {
        case .welcome: WelcomeStep(model: model)
        case .words: WordsStep(model: model)
        case .packs: PacksStep(model: model)
        case .whereItWorks: WhereStep(model: model)
        case .done: DoneStep(model: model)
        }
    }
}

/// One dot per step; filled up to the current one, and clickable so a user
/// can go back to a step they have already seen.
private struct ProgressDots: View {
    let flow: OnboardingFlow
    let go: (OnboardingStep) -> Void

    var body: some View {
        HStack(spacing: 7) {
            ForEach(OnboardingStep.allCases, id: \.self) { step in
                Dot(step: step,
                    filled: step <= flow.step,
                    current: step == flow.step,
                    done: flow.isComplete(step),
                    go: go)
            }
        }
        .animation(.easeOut(duration: 0.15), value: flow.step)
    }

    private struct Dot: View {
        let step: OnboardingStep
        let filled: Bool
        let current: Bool
        let done: Bool
        let go: (OnboardingStep) -> Void

        var body: some View {
            let size: CGFloat = current ? 9 : 7
            Button { go(step) } label: {
                Circle()
                    .fill(filled ? Color.accentColor : Color.secondary.opacity(0.25))
                    .frame(width: size, height: size)
            }
            .buttonStyle(.plain)
            .help(step.title)
            .accessibilityLabel(done ? "\(step.title), done" : step.title)
        }
    }
}

// MARK: - step 1

private struct WelcomeStep: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Lexicon fixes the names your dictation gets wrong \u{2014} in place, in whatever app you are typing in.")
                .font(.title3)
                .fixedSize(horizontal: false, vertical: true)

            GroupBox {
                VStack(alignment: .leading, spacing: 10) {
                    ExampleRow(label: "You said", text: "Ashlr.AI", symbol: "mic", tone: .secondary)
                    ExampleRow(label: "Dictation wrote", text: "Ashler", symbol: "text.badge.xmark", tone: .red, strikethrough: true)
                    ExampleRow(label: "Lexicon writes", text: "Ashlr.AI", symbol: "checkmark.circle", tone: .green, bold: true)
                }
                .padding(6)
            }

            VStack(alignment: .leading, spacing: 12) {
                Text("Status").font(.headline)
                StatusLine(
                    ok: model.accessibilityTrusted,
                    okText: "Accessibility is granted",
                    badText: "Accessibility is not granted yet \u{2014} corrections in other apps need it",
                    actionTitle: "Grant Accessibility",
                    action: { model.grantAccessibility() }
                )
                StatusLine(
                    ok: model.apiReachable,
                    okText: "Local API is running (\(model.apiTerms) terms)",
                    badText: "Local API is not reachable \u{2014} it does the correcting",
                    actionTitle: "Start the API",
                    action: { model.startLocalAPI() },
                    hint: "Or run `lexicon serve` in a terminal. The app can start it for you and keep it running."
                )
            }
        }
    }
}

private struct ExampleRow: View {
    let label: String
    let text: String
    let symbol: String
    let tone: Color
    var strikethrough = false
    var bold = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).foregroundStyle(tone).frame(width: 18)
            Text(label).foregroundStyle(.secondary).frame(width: 128, alignment: .leading)
            Text(text)
                .font(.system(.body, design: .rounded).weight(bold ? .semibold : .regular))
                .strikethrough(strikethrough, color: .secondary)
            Spacer()
        }
        .accessibilityElement(children: .combine)
    }
}

/// A checkmark / warning line, with a button and a hint that appear only
/// while the thing is not yet in place. `ok` is nil during the first check,
/// which shows a spinner rather than a red mark the user cannot act on.
private struct StatusLine: View {
    let ok: Bool?
    let okText: String
    let badText: String
    let actionTitle: String
    let action: () -> Void
    var hint: String?

    private var needsAction: Bool { ok == false }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                mark
                Text(ok == true ? okText : badText)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                if needsAction {
                    Button(actionTitle, action: action).controlSize(.small)
                }
            }
            if needsAction, let hint {
                Text(hint)
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(.leading, 22)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private var mark: some View {
        if ok == true {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.green).frame(width: 14)
        } else if ok == false {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Color.orange).frame(width: 14)
        } else {
            ProgressView().controlSize(.small).frame(width: 14, height: 14)
        }
    }
}

// MARK: - step 2

private struct WordsStep: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Type a name the way it should be spelled. Lexicon suggests what dictation is likely to write instead \u{2014} switch off anything wrong, add your own.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: 12) {
                ForEach(model.drafts) { draft in
                    TermRow(model: model, draft: draft)
                }
            }

            HStack {
                Button {
                    model.addDraft()
                } label: {
                    Label("Add another", systemImage: "plus")
                }
                .controlSize(.small)
                Spacer()
                if !model.savedTerms.isEmpty {
                    Label("\(model.savedTerms.count) saved", systemImage: "checkmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.green)
                }
            }

            Divider()

            TryItBox(model: model)

            if let error = model.lastError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// One row of the table: the canonical field plus its chips.
private struct TermRow: View {
    @ObservedObject var model: OnboardingModel
    let draft: TermDraft
    @FocusState private var focused: Bool

    /// The chip area keeps this height whether it is empty, loading or full,
    /// so the row never jumps while `GET /aliases` is in flight.
    private let chipAreaHeight: CGFloat = 30

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TextField("Correct spelling", text: Binding(
                    get: { draft.canonical },
                    set: { model.canonicalChanged(draft.id, to: $0) }
                ))
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit { model.commitDraft(draft.id) }
                .onChange(of: focused) { isFocused in
                    if !isFocused { model.commitDraft(draft.id) }
                }
                .accessibilityLabel("Correct spelling")

                if draft.submitted {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .help("Saved to your lexicon")
                }
                Button {
                    model.removeDraft(draft.id)
                } label: {
                    Image(systemName: "minus.circle")
                }
                .buttonStyle(.borderless)
                .help("Remove this row")
                .accessibilityLabel("Remove this row")
            }

            ChipArea(model: model, draft: draft)
                .frame(minHeight: chipAreaHeight, alignment: .topLeading)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: .separatorColor)))
    }
}

private struct ChipArea: View {
    @ObservedObject var model: OnboardingModel
    let draft: TermDraft
    @State private var custom = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if draft.isLoadingSuggestions {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Looking up what dictation writes\u{2026}")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .frame(height: 22)
            } else if draft.chips.isEmpty {
                Text(draft.isReady
                     ? "No suggestions. Add what dictation actually writes below."
                     : "Suggestions appear once you type a name.")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(height: 22)
            } else {
                ChipFlow(chips: draft.chips) { model.toggleChip(draft.id, chip: $0) }
            }

            if draft.isReady {
                HStack(spacing: 6) {
                    TextField("what dictation actually writes", text: $custom)
                        .textFieldStyle(.roundedBorder)
                        .controlSize(.small)
                        .onSubmit(addCustom)
                        .accessibilityLabel("Add a spelling dictation writes")
                    Button("Add", action: addCustom)
                        .controlSize(.small)
                        .disabled(custom.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                .frame(maxWidth: 360)
            }
        }
    }

    private func addCustom() {
        model.addCustomAlias(draft.id, alias: custom)
        custom = ""
    }
}

/// Chips wrapped across as many lines as they need. `Layout` is macOS 13+, so
/// this is a plain flow layout rather than a stack of guessed rows.
private struct ChipFlow: View {
    let chips: [AliasChip]
    let toggle: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(chips) { chip in
                Button {
                    toggle(chip.id)
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: chip.isOn ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 10))
                        Text(chip.text).font(.caption)
                        if chip.isCustom {
                            Image(systemName: "person.crop.circle")
                                .font(.system(size: 9))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(
                        Capsule().fill(chip.isOn
                                       ? AnyShapeStyle(Color.accentColor.opacity(0.18))
                                       : AnyShapeStyle(Color.secondary.opacity(0.10)))
                    )
                    .overlay(Capsule().strokeBorder(chip.isOn ? Color.accentColor.opacity(0.45) : Color.secondary.opacity(0.25)))
                    .foregroundStyle(chip.isOn ? Color.primary : Color.secondary)
                }
                .buttonStyle(.plain)
                .help(chip.isOn ? "Lexicon will correct this spelling" : "Switched off")
                .accessibilityLabel(chip.text)
                .accessibilityValue(chip.isOn ? "on" : "off")
                .accessibilityAddTraits(.isButton)
            }
        }
    }
}

/// Minimal flow layout: place subviews left to right, wrap at the proposed width.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 400
        let rows = arrange(subviews: subviews, width: width)
        let height = rows.last.map { $0.y + $0.height } ?? 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = arrange(subviews: subviews, width: bounds.width)
        for row in rows {
            for item in row.items {
                subviews[item.index].place(
                    at: CGPoint(x: bounds.minX + item.x, y: bounds.minY + row.y),
                    proposal: ProposedViewSize(item.size))
            }
        }
    }

    private struct Row {
        var y: CGFloat
        var height: CGFloat
        var items: [(index: Int, x: CGFloat, size: CGSize)]
    }

    private func arrange(subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = []
        var current = Row(y: 0, height: 0, items: [])
        var x: CGFloat = 0
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                rows.append(current)
                current = Row(y: current.y + current.height + spacing, height: 0, items: [])
                x = 0
            }
            current.items.append((index, x, size))
            current.height = max(current.height, size.height)
            x += size.width + spacing
        }
        if !current.items.isEmpty { rows.append(current) }
        return rows
    }
}

/// Live `POST /normalize` on whatever the user types, debounced. This is the
/// moment the whole window exists for: their own name, fixed as they watch.
private struct TryItBox: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Label("Try it", systemImage: "wand.and.stars").font(.headline)
                if model.tryItBusy {
                    ProgressView().controlSize(.small)
                }
                Spacer()
            }
            Text("Type or paste a sentence the way dictation would write it.")
                .font(.caption).foregroundStyle(.secondary)

            TextField("ping ashler about the cooper netties rollout", text: Binding(
                get: { model.tryItText },
                set: { model.tryItChanged($0) }
            ), axis: .vertical)
            .textFieldStyle(.roundedBorder)
            .lineLimit(2...4)
            .accessibilityLabel("Sentence to correct")

            // Fixed height whether or not there is an answer, so typing does
            // not shuffle the step under the cursor.
            Group {
                if let output = model.tryItOutput {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: model.tryItReplacements.isEmpty ? "equal.circle" : "arrow.down.circle.fill")
                            .foregroundStyle(model.tryItReplacements.isEmpty ? Color.secondary : Color.green)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(highlighted(output))
                                .fixedSize(horizontal: false, vertical: true)
                            Text(model.tryItReplacements.isEmpty
                                 ? "Nothing to fix in that sentence yet."
                                 : model.tryItReplacements.map(\.label).joined(separator: ",  "))
                                .font(.caption).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer()
                    }
                } else {
                    Text("The corrected sentence appears here.")
                        .font(.callout).foregroundStyle(.tertiary)
                }
            }
            .frame(minHeight: 54, alignment: .topLeading)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .textBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: .separatorColor)))
        }
    }

    /// The canonical spellings bolded inside the corrected sentence.
    private func highlighted(_ output: String) -> AttributedString {
        var attributed = AttributedString(output)
        for range in OnboardingModel.highlightRanges(in: output, replacements: model.tryItReplacements) {
            guard let lower = AttributedString.Index(range.lowerBound, within: attributed),
                  let upper = AttributedString.Index(range.upperBound, within: attributed) else { continue }
            attributed[lower..<upper].font = .body.weight(.semibold)
            attributed[lower..<upper].foregroundColor = .primary
        }
        return attributed
    }
}

// MARK: - step 3

private struct PacksStep: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Vocabulary other people have already written down. Switch one on and its terms go straight into your lexicon; switch it off and they come back out.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if model.packsLoading {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading packs\u{2026}").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 200)
            } else if let error = model.packsError, model.packs.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Could not load the packs", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                    Text(error).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(spacing: 10) {
                    ForEach(model.packs) { pack in
                        PackCard(model: model, pack: pack)
                    }
                }
                if let error = model.packsError {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

private struct PackCard: View {
    @ObservedObject var model: OnboardingModel
    let pack: LocalAPI.Pack

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 18))
                .foregroundStyle(.tint)
                .frame(width: 26)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 4) {
                Text(pack.title).font(.headline)
                Text(pack.description)
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Text("\(pack.terms) terms, \(pack.aliases) spellings")
                        .font(.caption2).foregroundStyle(.tertiary)
                    if let summary = model.packSummaries[pack.name] {
                        Text("\u{00B7}").font(.caption2).foregroundStyle(.tertiary)
                        Text(summary).font(.caption2).foregroundStyle(.green)
                    }
                }
                // Reserved so the card does not grow when the summary lands.
                .frame(height: 14, alignment: .leading)
            }

            Spacer(minLength: 8)

            if model.packSelection.isBusy(pack.name) {
                ProgressView().controlSize(.small).frame(width: 38)
            } else {
                Toggle("", isOn: Binding(
                    get: { model.packSelection.isInstalled(pack.name) },
                    set: { _ in model.togglePack(pack.name) }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .accessibilityLabel(pack.title)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor)))
    }

    private var symbol: String {
        switch pack.name {
        case "developer": return "hammer"
        case "ai": return "brain"
        case "business": return "chart.line.uptrend.xyaxis"
        case "voice-tools": return "mic"
        default: return "shippingbox"
        }
    }
}

// MARK: - step 4

private struct WhereStep: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 12) {
                Toggle(isOn: Binding(
                    get: { model.settings.fixEverywhere },
                    set: { model.settings.fixEverywhere = $0 }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Fix everywhere")
                        Text("Rewrites dictated text in the focused field of any app, about a second after it lands. Needs Accessibility.")
                            .font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Toggle(isOn: Binding(
                    get: { model.settings.watchClipboard },
                    set: { model.settings.watchClipboard = $0 }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Watch clipboard")
                        Text("Corrects anything you copy, so a paste is already right.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }

                LocalAPIRow(model: model)

                Toggle(isOn: Binding(
                    get: { model.settings.showBubble },
                    set: { model.settings.showBubble = $0 }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Show the correction bubble")
                        Text("A small panel near the caret after each fix, with Undo.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }

            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    HotkeyLine(keys: model.settings.pushToTalkHotKey.displayString, what: "Push to talk")
                    HotkeyLine(keys: model.settings.fixClipboardHotKey.displayString, what: "Fix the clipboard now")
                    HotkeyLine(keys: model.settings.undoFixHotKey.displayString, what: "Undo the last fix")
                }
                .padding(6)
            }

            Text("Now dictate anywhere: Slack, Mail, Claude, Cursor. We fix it in place.")
                .font(.title3)
                .fixedSize(horizontal: false, vertical: true)

            Divider()

            TryItBox(model: model)
        }
    }
}

/// The local-API row of step 4. It is a checkbox only when this app could
/// actually start or stop the server; when a LaunchAgent (or anything else)
/// already owns the port it becomes a status line with a note on how to manage
/// it, so ticking it can never start a duplicate that fails to bind. The words
/// come from the same `ServeOwnership.resolve` the menu uses.
private struct LocalAPIRow: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        if model.serveStatus.isInteractive {
            Toggle(isOn: Binding(
                get: { model.settings.localAPI || model.serveStatus.isOn },
                set: { model.setLocalAPI($0) }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.serveStatus.title)
                    Text(model.serveStatus.detail)
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let hint = model.serveStatus.hint {
                        Text(hint)
                            .font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        } else {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: model.serveStatus.isOn ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(model.serveStatus.isOn ? Color.green : Color.orange)
                    .frame(width: 14)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.serveStatus.title)
                    Text(model.serveStatus.detail)
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let hint = model.serveStatus.hint {
                        Text(hint)
                            .font(.caption).foregroundStyle(.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer()
            }
            .accessibilityElement(children: .combine)
        }
    }
}

private struct HotkeyLine: View {
    let keys: String
    let what: String

    var body: some View {
        HStack(spacing: 10) {
            Text(keys)
                .font(.system(.body, design: .monospaced))
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 5).fill(Color.secondary.opacity(0.12)))
                .frame(width: 84, alignment: .leading)
            Text(what).foregroundStyle(.secondary)
            Spacer()
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - step 5

private struct DoneStep: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 26))
                    .foregroundStyle(.green)
                Text("Your lexicon has \(model.summaryTerms) terms and \(model.summaryAliases) spellings.")
                    .font(.title3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    if !model.savedTerms.isEmpty {
                        SummaryLine(symbol: "textformat.abc",
                                    text: "Added: \(model.savedTerms.joined(separator: ", "))")
                    }
                    let installed = model.packs.filter { model.packSelection.isInstalled($0.name) }
                    if !installed.isEmpty {
                        SummaryLine(symbol: "shippingbox",
                                    text: "\(installed.count) packs on: \(installed.map(\.title).joined(separator: ", "))")
                    }
                    ForEach(model.enabledSummary, id: \.self) { line in
                        SummaryLine(symbol: "checkmark", text: line)
                    }
                }
                .padding(6)
            }

            Text("Dictate in any app and the names come out spelled right. \(model.settings.undoFixHotKey.displayString) puts a correction back; the bubble near the caret has the same button.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 10) {
                Button {
                    model.openLexiconFile?()
                } label: {
                    Label("Open the lexicon file", systemImage: "doc.text")
                }
                Spacer()
            }
        }
    }
}

private struct SummaryLine: View {
    let symbol: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 16)
            Text(text).fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
        .accessibilityElement(children: .combine)
    }
}
