import XCTest
@testable import LexiconBarKit

final class OnboardingSupportTests: XCTestCase {
    // MARK: step state machine

    func testStartsAtWelcomeWithNothingComplete() {
        let flow = OnboardingFlow()
        XCTAssertEqual(flow.step, .welcome)
        XCTAssertTrue(flow.isFirst)
        XCTAssertFalse(flow.isLast)
        XCTAssertTrue(flow.completed.isEmpty)
    }

    func testNextCompletesTheCurrentStepAndAdvances() {
        var flow = OnboardingFlow()
        flow.next()
        XCTAssertEqual(flow.step, .words)
        XCTAssertTrue(flow.isComplete(.welcome))
        XCTAssertFalse(flow.isComplete(.words))
    }

    func testNextWalksEveryStepAndStopsAtDone() {
        var flow = OnboardingFlow()
        for _ in 0..<10 { flow.next() }
        XCTAssertEqual(flow.step, .done)
        XCTAssertTrue(flow.isLast)
        XCTAssertEqual(flow.completed, Set(OnboardingStep.allCases))
    }

    func testBackMovesBackAndKeepsCompletion() {
        var flow = OnboardingFlow()
        flow.next()   // welcome done -> words
        flow.next()   // words done -> packs
        flow.back()
        XCTAssertEqual(flow.step, .words)
        XCTAssertTrue(flow.isComplete(.welcome))
        XCTAssertTrue(flow.isComplete(.words), "walking back must not undo what the user already did")
    }

    func testBackStopsAtTheFirstStep() {
        var flow = OnboardingFlow()
        flow.back()
        flow.back()
        XCTAssertEqual(flow.step, .welcome)
    }

    func testSkipAdvancesWithoutCompleting() {
        var flow = OnboardingFlow(step: .words)
        flow.skip()
        XCTAssertEqual(flow.step, .packs)
        XCTAssertFalse(flow.isComplete(.words))
    }

    func testSkipToEndJumpsToDoneCompletingNothing() {
        var flow = OnboardingFlow()
        flow.next()   // welcome complete
        flow.skipToEnd()
        XCTAssertEqual(flow.step, .done)
        XCTAssertEqual(flow.completed, [.welcome])
        XCTAssertFalse(flow.isComplete(.packs))
    }

    func testGoToJumpsWithoutCompleting() {
        var flow = OnboardingFlow()
        flow.go(to: .packs)
        XCTAssertEqual(flow.step, .packs)
        XCTAssertTrue(flow.completed.isEmpty)
    }

    func testDotsFillUpToTheCurrentStep() {
        var flow = OnboardingFlow()
        XCTAssertEqual(flow.dots, [true, false, false, false, false])
        flow.next()
        flow.next()
        XCTAssertEqual(flow.dots, [true, true, true, false, false])
    }

    func testStepOrderIsTheOneTheWindowWalks() {
        XCTAssertEqual(OnboardingStep.allCases, [.welcome, .words, .packs, .whereItWorks, .done])
    }

    // MARK: alias chips

    func testSuggestionsArriveSwitchedOn() {
        var draft = TermDraft(canonical: "Ashlr.AI")
        draft.applySuggestions(["ashler", "ashlar", "ash lar"], for: "Ashlr.AI")
        XCTAssertEqual(draft.chips.map(\.text), ["ashler", "ashlar", "ash lar"])
        XCTAssertTrue(draft.chips.allSatisfy(\.isOn))
        XCTAssertEqual(draft.selectedAliases, ["ashler", "ashlar", "ash lar"])
        XCTAssertFalse(draft.isLoadingSuggestions)
    }

    func testTogglingAChipDropsItFromTheSelection() {
        var draft = TermDraft(canonical: "Ashlr.AI")
        draft.applySuggestions(["ashler", "ashlar"], for: "Ashlr.AI")
        draft.toggle("ashlar")
        XCTAssertEqual(draft.selectedAliases, ["ashler"])
        draft.toggle("ashlar")
        XCTAssertEqual(draft.selectedAliases, ["ashler", "ashlar"])
    }

    func testTogglingAnUnknownChipIsIgnored() {
        var draft = TermDraft(canonical: "Ashlr.AI")
        draft.applySuggestions(["ashler"], for: "Ashlr.AI")
        draft.toggle("nope")
        XCTAssertEqual(draft.selectedAliases, ["ashler"])
    }

    func testARefetchKeepsTheUsersToggleAndAddsOnlyNewSuggestions() {
        var draft = TermDraft(canonical: "Ashlr.AI")
        draft.applySuggestions(["ashler", "ashlar"], for: "Ashlr.AI")
        draft.toggle("ashlar")                       // user says no to this one
        draft.applySuggestions(["ashler", "ashlar", "ash lar"], for: "Ashlr.AI")
        XCTAssertEqual(draft.chips.count, 3)
        XCTAssertEqual(draft.selectedAliases, ["ashler", "ash lar"])
    }

    func testSuggestionsAreDedupedCaseInsensitivelyAndNeverEqualTheCanonical() {
        var draft = TermDraft(canonical: "Kubernetes")
        draft.applySuggestions(["cooper netties", "Cooper Netties", "kubernetes", "  ", "coober netties"], for: "Kubernetes")
        XCTAssertEqual(draft.chips.map(\.text), ["cooper netties", "coober netties"])
    }

    func testCustomAliasesAreAddedOnAndMarkedCustom() {
        var draft = TermDraft(canonical: "Ashlr.AI")
        XCTAssertTrue(draft.addCustom("  ashe lair  "))
        XCTAssertEqual(draft.chips.map(\.text), ["ashe lair"])
        XCTAssertTrue(draft.chips[0].isCustom)
        XCTAssertEqual(draft.selectedAliases, ["ashe lair"])
    }

    func testBlankOrCanonicalCustomAliasesAreRefused() {
        var draft = TermDraft(canonical: "Ashlr.AI")
        XCTAssertFalse(draft.addCustom("   "))
        XCTAssertFalse(draft.addCustom("ashlr.ai"))
        XCTAssertTrue(draft.chips.isEmpty)
    }

    func testAddingAnAliasThatIsAlreadyThereSwitchesItBackOn() {
        var draft = TermDraft(canonical: "Ashlr.AI")
        draft.applySuggestions(["ashler"], for: "Ashlr.AI")
        draft.toggle("ashler")
        XCTAssertEqual(draft.selectedAliases, [])
        XCTAssertFalse(draft.addCustom("Ashler"), "no new chip")
        XCTAssertEqual(draft.chips.count, 1)
        XCTAssertEqual(draft.selectedAliases, ["ashler"], "but the one that is there comes back on")
    }

    func testChangingTheCanonicalDropsSuggestionsButKeepsTypedAliases() {
        var draft = TermDraft(canonical: "Ashlr.AI")
        draft.applySuggestions(["ashler", "ashlar"], for: "Ashlr.AI")
        draft.addCustom("ashe lair")
        draft.canonicalChanged(to: "Kubernetes")
        XCTAssertEqual(draft.chips.map(\.text), ["ashe lair"])
        XCTAssertNil(draft.suggestionsFor)
        XCTAssertTrue(draft.needsSuggestions)
    }

    func testRetypingTheSameCanonicalDoesNotRefetch() {
        var draft = TermDraft(canonical: "Ashlr.AI")
        draft.applySuggestions(["ashler"], for: "Ashlr.AI")
        XCTAssertFalse(draft.needsSuggestions)
        draft.canonicalChanged(to: "  Ashlr.AI  ")
        XCTAssertFalse(draft.needsSuggestions, "whitespace and case are not a new term")
        XCTAssertEqual(draft.chips.count, 1)
    }

    func testAnEmptyRowIsNeitherReadyNorWorthFetching() {
        var draft = TermDraft()
        XCTAssertFalse(draft.isReady)
        XCTAssertFalse(draft.needsSuggestions)
        draft.canonical = "  Vercel "
        XCTAssertTrue(draft.isReady)
        XCTAssertTrue(draft.needsSuggestions)
        XCTAssertEqual(draft.trimmedCanonical, "Vercel")
    }

    func testRemovingAChip() {
        var draft = TermDraft(canonical: "Ashlr.AI")
        draft.applySuggestions(["ashler", "ashlar"], for: "Ashlr.AI")
        draft.removeChip("ashler")
        XCTAssertEqual(draft.chips.map(\.text), ["ashlar"])
    }

    // MARK: pack selection

    func testDefaultsMatchTheCLI() {
        XCTAssertEqual(PackSelection.defaults, ["developer", "ai", "voice-tools"])
    }

    func testToggleIsOptimisticAndSettlesOnSuccess() {
        var packs = PackSelection(installed: ["developer"])
        let wanted = packs.beginToggle("business")
        XCTAssertTrue(wanted)
        XCTAssertTrue(packs.isInstalled("business"), "the card flips before the request lands")
        XCTAssertTrue(packs.isBusy("business"))
        packs.endToggle("business", succeeded: true, wantedInstalled: wanted)
        XCTAssertTrue(packs.isInstalled("business"))
        XCTAssertFalse(packs.isBusy("business"))
    }

    func testAFailedInstallRollsBack() {
        var packs = PackSelection(installed: ["developer"])
        let wanted = packs.beginToggle("business")
        packs.endToggle("business", succeeded: false, wantedInstalled: wanted)
        XCTAssertFalse(packs.isInstalled("business"))
        XCTAssertFalse(packs.isBusy("business"))
    }

    func testAFailedRemovalRollsBack() {
        var packs = PackSelection(installed: ["developer"])
        let wanted = packs.beginToggle("developer")
        XCTAssertFalse(wanted)
        XCTAssertFalse(packs.isInstalled("developer"))
        packs.endToggle("developer", succeeded: false, wantedInstalled: wanted)
        XCTAssertTrue(packs.isInstalled("developer"))
    }

    func testReconcileTakesTheServerListButNotOverAToggleInFlight() {
        var packs = PackSelection(installed: ["developer", "ai"])
        let wanted = packs.beginToggle("business")   // in flight, optimistically on
        packs.reconcile(with: ["developer", "ai", "voice-tools"])
        XCTAssertTrue(packs.isInstalled("voice-tools"), "the server knew about one we did not")
        XCTAssertTrue(packs.isInstalled("business"), "a slow list must not undo the click")
        packs.endToggle("business", succeeded: true, wantedInstalled: wanted)
        packs.reconcile(with: ["developer", "ai", "voice-tools", "business"])
        XCTAssertEqual(packs.installed, ["developer", "ai", "voice-tools", "business"])
    }
}
