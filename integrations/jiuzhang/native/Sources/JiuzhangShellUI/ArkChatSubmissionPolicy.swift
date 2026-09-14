import Foundation

/// Pure native-chat keyboard policy shared by the AppModel and contract checks.
public enum ArkChatSubmissionPolicy {
  public static func shouldSteerWholeQueue(
    draft: String,
    pendingImageCount: Int,
    sessionRunning: Bool,
    sessionOrigin: String?,
    queuedCount: Int
  ) -> Bool {
    // sessionOrigin is kept for call-site clarity: continuable subagent queues take the same
    // treatment as ordinary ones now that the Host route accepts their queue mutations.
    _ = sessionOrigin
    return draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && pendingImageCount == 0
      && sessionRunning
      && queuedCount > 0
  }
}
