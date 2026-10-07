import AVFoundation
import XCTest
@testable import MeetingCopilot

/// The mic engine is built and released off the main thread, and a Core Audio
/// call that never returns cannot hold the app. On 2026-10-02 the main thread
/// released the old engine during a restart, deadlocked inside Core Audio, and
/// the app froze until it was force-quit.
final class MicEngineQueueTests: XCTestCase {
    private func fakeStart() -> AudioCaptureManager.MicEngineStart {
        let engine = AVAudioEngine()
        return .init(engine: engine, pinned: nil, hardwareFormat: AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!)
    }

    func testTheEngineIsBuiltOffTheMainThread() {
        let capture = AudioCaptureManager()
        var builtOnMain: Bool?
        capture.micEngineFactory = { _ in
            builtOnMain = Thread.isMainThread
            return self.fakeStart()
        }
        let opened = expectation(description: "opened")
        capture.openMic { result in
            if case .failure(let error) = result { XCTFail("\(error)") }
            opened.fulfill()
        }
        wait(for: [opened], timeout: 2)
        XCTAssertEqual(builtOnMain, false)
    }

    func testAHungCoreAudioCallTimesOutAndTheNextOpenWorks() {
        let capture = AudioCaptureManager()
        let release = DispatchSemaphore(value: 0)
        let hung = fakeStart()
        capture.micEngineFactory = { _ in
            release.wait()  // Core Audio never answers
            return .init(engine: hung.engine, pinned: nil, hardwareFormat: hung.hardwareFormat)
        }

        // The main thread keeps running: this expectation is fulfilled on it.
        let stuck = expectation(description: "stuck open reports failure")
        capture.openMic(timeout: 0.3) { result in
            guard case .failure(AudioCaptureError.microphoneStuck) = result else {
                return XCTFail("expected microphoneStuck, got \(result)")
            }
            stuck.fulfill()
        }
        wait(for: [stuck], timeout: 2)

        // A fresh thread serves the next open while the old one is still hung.
        let good = fakeStart()
        capture.micEngineFactory = { _ in good }
        let reopened = expectation(description: "reopened")
        capture.openMic(timeout: 2) { result in
            if case .failure(let error) = result { XCTFail("\(error)") }
            reopened.fulfill()
        }
        wait(for: [reopened], timeout: 3)
        XCTAssertTrue(capture.micEngineForTesting === good.engine)

        // When the hung call finally returns, its engine is discarded.
        release.signal()
        let settled = expectation(description: "late result handled")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { settled.fulfill() }
        wait(for: [settled], timeout: 2)
        XCTAssertTrue(capture.micEngineForTesting === good.engine)
    }
    // 2026-10-07: every restart retried the pinned built-in mic, which would
    // not start while the AirPods were in a call, so the mic looped between
    // devices until a restart hung. Once the default had to stand in, it stays.
    func testAFallbackToTheDefaultSticksForTheSession() throws {
        let capture = AudioCaptureManager()
        try XCTSkipIf(AppSettings.micDevice == .systemDefault, "needs a pinned mic preference")
        var asked: [MicDevicePicker.Preference] = []
        capture.micEngineFactory = { preference in
            asked.append(preference)
            return self.fakeStart()  // pinned: nil, i.e. it ended on the default
        }
        for _ in 0..<2 {
            let opened = expectation(description: "opened")
            capture.openMic { _ in opened.fulfill() }
            wait(for: [opened], timeout: 2)
        }
        XCTAssertEqual(asked.count, 2)
        XCTAssertNotEqual(asked[0], .systemDefault)
        XCTAssertEqual(asked[1], .systemDefault)
    }

    // 2026-10-07: one -10868 on the first open aborted the session.
    func testTheFirstOpenRetriesAPlainFailure() async throws {
        let capture = AudioCaptureManager()
        var calls = 0
        capture.micEngineFactory = { _ in
            calls += 1
            if calls < 3 { throw AudioCaptureError.microphoneUnavailable }
            return self.fakeStart()
        }
        try await capture.openMicForStart()
        XCTAssertEqual(calls, 3)
    }

    func testTheFirstOpenGivesUpAfterThreeAttempts() async {
        let capture = AudioCaptureManager()
        var calls = 0
        capture.micEngineFactory = { _ in
            calls += 1
            throw AudioCaptureError.microphoneUnavailable
        }
        do {
            try await capture.openMicForStart()
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(calls, 3)
        }
    }

    // 2026-10-07: the process tap's AudioDeviceStart never returned and the
    // session sat in priming for good. A start that never answers must end.
    func testAMeetingAudioStartThatNeverAnswersTimesOutAndIsUndoneLate() async {
        var finishLate: ((Result<Int, Error>) -> Void)?
        let undone = expectation(description: "late start undone")
        do {
            _ = try await AudioCaptureManager.boundedStart(0.2, what: "test", start: { done in
                finishLate = done  // Core Audio never answers
            }, onLate: { value in
                XCTAssertEqual(value, 7)
                undone.fulfill()
            })
            XCTFail("expected meetingAudioStuck")
        } catch AudioCaptureError.meetingAudioStuck {
        } catch {
            XCTFail("expected meetingAudioStuck, got \(error)")
        }
        finishLate?(.success(7))
        await fulfillment(of: [undone], timeout: 1)
    }

    func testABoundedStartThatAnswersReturnsItsValue() async throws {
        let value = try await AudioCaptureManager.boundedStart(2, what: "test", start: { done in
            DispatchQueue.global().async { done(.success(42)) }
        }, onLate: { _ in XCTFail("not late") })
        XCTAssertEqual(value, 42)
    }
}
