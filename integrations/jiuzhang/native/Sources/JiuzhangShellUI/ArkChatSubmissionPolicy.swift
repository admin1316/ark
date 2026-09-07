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
    draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && pendingImageCount == 0
      && sessionRunning
      && sessionOrigin != "subagent"
      && queuedCount > 0
  }
}
