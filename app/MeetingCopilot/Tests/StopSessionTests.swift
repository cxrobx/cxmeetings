import XCTest
@testable import MeetingCopilot

/// A Stop that can't reach the server must not pretend the meeting ended:
/// it stays live (still recording, and says so) and retries.
@MainActor
final class StopSessionTests: XCTestCase {
    func testStopWithoutServerStaysLive() async {
        let manager = SessionManager()
        manager.currentSession = Session(state: .live, title: "Unreachable stop")
        manager.state = .live
        manager.isRecording = true
        var surfaced: String?
        manager.onError = { surfaced = $0 }

        let outcome = await manager.requestStop(source: "test")

        XCTAssertEqual(outcome, .unreachable)
        XCTAssertEqual(manager.state, .live, "nothing reached the server, so the meeting is still on")
        XCTAssertTrue(manager.isRecording)
        XCTAssertNotNil(surfaced, "the failure is shown, not swallowed")
        manager.currentSession = nil
    }

    func testStopWithNoLiveMeetingSaysSo() async {
        let manager = SessionManager()
        let outcome = await manager.requestStop(source: "test")
        XCTAssertEqual(outcome, .notLive)
        XCTAssertEqual(manager.state, .idle)
    }
}
