import Darwin
import Foundation

extension ArkProtectedOwner {
  public func reviewSnapshot() -> ArkProtectedOwnerReviewSnapshotV2 {
    ArkProtectedOwnerReviewSnapshotV2(ownerRevision: store.revision, reviews: pendingDescriptors())
  }

  /// App-only registration from the compiled helper's pinned pre-observation intent.
  public func registerObservationIntent() async throws -> ArkProtectedTrialDescriptor {
    guard store.observationVersion, let evaluator = observationEvaluator else {
      throw ArkProtectedOwnerError.rejected("Observation owner is not provisioned")
    }
    let revision = store.revision
    try evaluator.validateInitialObservationSources()
    let (intentHash, intent) = try evaluator.admissionIntent()
    let descriptor = try await evaluator.intentDescriptor()
    if publicBinding != nil { _ = try publicHello(descriptors: [descriptor]) }
    try Task.checkCancellation()
    try evaluator.validateInitialObservationSources()
    guard store.revision == revision, let slots = intent["core"]?["orderedSlots"]?.arrayValue,
      slots.map({ $0["sessionId"]?.stringValue }) == descriptor.sessionIDs.map(Optional.some),
      (2...32).contains(slots.count), slots.count % 2 == 0,
      !store.trials.contains(where: { $0.descriptor.grantHash == descriptor.grantHash || $0.intentHash == intentHash }) else {
      throw ArkProtectedOwnerError.rejected("Registration actor fence, identities or duplicate intent differs")
    }
    var trial = ArkProtectedTrialState(descriptor: descriptor, phase: "registered", reservations: [])
    trial.intentHash = intentHash; trial.registrationEpoch = revision + 1; trial.inflightEpoch = 0
    trial.orderedSlotEpochs = slots.map { .object(["sessionId": $0["sessionId"]!, "firstDispatchEpoch": .null]) }
    trial.collection = .object(["generationId": .string(UUID().uuidString.lowercased()), "phase": .string("collecting"),
      "nextSlotIndex": .number(0), "reservationRevision": .null, "inflightEpoch": .number(1),
      "orderedCaptures": .array([]), "reason": .null, "failureEvidenceHash": .null])
    try store.replace(store.trials + [trial])
    return descriptor
  }

  public func bindCollectingSlot(descriptorHash: String, channel: ArkNativeOwnerChannel) throws {
    guard let trial = store.trials.first(where: { $0.descriptor.descriptorHash == descriptorHash }), trial.phase == "admitted",
      trial.freeze == nil, trial.collection?["phase"] == .string("collecting"),
      !ownedSlotJoins.values.contains(where: { $0.channelGeneration == channel.generation }),
      channel.role == .backend else { throw ArkProtectedOwnerError.rejected("Current slot channel is unavailable or reused") }
    collectingChannelGeneration = channel.generation
  }
  public func bindGuardProcess(_ guardProcess: ArkProtectedGuardProcess) throws {
    guard guardChannelGeneration == nil, guardProcess.isRunning, let generation = guardProcess.channelGeneration,
      let endpoint = guardProcess.readyURL?.absoluteString, let evaluator = observationEvaluator else {
      throw ArkProtectedOwnerError.rejected("Guard generation cannot be replaced or is not owned")
    }
    let (_, intent) = try evaluator.admissionIntent()
    guard intent["core"]?["cost"]?["endpoint"] == .string(endpoint) else { throw ArkProtectedOwnerError.rejected("Actual ready guard URL differs from immutable intent") }
    guardChannelGeneration = generation
  }

  /// Only the reaped App-owned process can yield this receipt. It is not task proof;
  /// the fixed capture helper independently verifies the complete durable turn.
  public func recordJoinedSlot(descriptorHash: String, backend: BackendProcess) throws {
    guard let trial = store.trials.first(where: { $0.descriptor.descriptorHash == descriptorHash }), trial.phase == "admitted",
      trial.freeze == nil, trial.collection?["phase"] == .string("collecting"),
      let cursor = trial.collection?["nextSlotIndex"]?.jsonSafeInteger(), cursor < trial.descriptor.sessionIDs.count,
      let receipt = backend.joinedReceipt, receipt.exitedNormally, receipt.terminationStatus == 0, !receipt.forced,
      receipt.channelGeneration == collectingChannelGeneration, !ownedSlotJoins.values.contains(where: { $0.generation == receipt.generation }),
      !ownedSlotJoins.values.contains(where: { $0.channelGeneration == receipt.channelGeneration }) else {
      throw ArkProtectedOwnerError.rejected("Owned slot has not normally joined or reused a launch")
    }
    ownedSlotJoins[trial.descriptor.sessionIDs[cursor]] = receipt
    collectingChannelGeneration = nil
  }

  public func recordJoinedGuard(_ guardProcess: ArkProtectedGuardProcess) throws {
    guard let receipt = guardProcess.joinedReceipt, receipt.exitedNormally, receipt.terminationStatus == 0, !receipt.forced,
      receipt.channelGeneration == guardChannelGeneration else { throw ArkProtectedOwnerError.rejected("Owned guard did not normally join") }
    ownedGuardJoin = receipt
  }

  /// A new channel is required because every model channel closes at slot exit.
  public func bindFrozenProducer(descriptorHash: String, channel: ArkNativeOwnerChannel, evaluator: ArkProtectedEvaluator) throws {
    guard let trial = store.trials.first(where: { $0.descriptor.descriptorHash == descriptorHash }), trial.phase == "admitted",
      trial.freeze?["phase"] == .string("frozen"), frozenProducerGeneration == nil, channel.role == .offlineProducer,
      trial.freeze?["completedLaunchHash"] == .string(try evaluator.completedLaunchHash()),
      !ownedSlotJoins.values.contains(where: { $0.channelGeneration == channel.generation }),
      ownedGuardJoin?.channelGeneration != channel.generation else {
      throw ArkProtectedOwnerError.rejected("Frozen producer launch or channel differs")
    }
    try trial.descriptor.validate()
    frozenProducerGeneration = channel.generation; completedEvaluator = evaluator
  }

  func observationTrial(_ hash: String, revision: Int) throws -> (Int, ArkProtectedTrialState, ArkProtectedEvaluator) {
    guard store.observationVersion, let evaluator = observationEvaluator, revision == store.revision,
      let index = store.trials.firstIndex(where: { $0.descriptor.descriptorHash == hash }), store.trials[index].phase == "admitted" else {
      throw ArkProtectedOwnerError.rejected("Stale revision or trial not admitted")
    }
    let trial = store.trials[index]; try trial.descriptor.validate()
    guard trial.collection?["phase"] != .string("failed"), trial.freeze == nil else {
      throw ArkProtectedOwnerError.rejected("Observation failed, freezing, frozen or restart-uncertain")
    }
    return (index, trial, evaluator)
  }

  func observationFence(_ trial: ArkProtectedTrialState, revision: Int) throws {
    try Task.checkCancellation(); try trial.descriptor.validate()
    guard store.revision == revision, store.trials.contains(where: { current in
      current.descriptor == trial.descriptor && current.intentHash == trial.intentHash && current.phase == "admitted"
        && current.collection == trial.collection && current.freeze == trial.freeze && current.inflightEpoch == trial.inflightEpoch
    }) else { throw ArkProtectedOwnerError.rejected("Observation actor fence conflict") }
  }

  func observationInput(_ trial: ArkProtectedTrialState, operation: String, revision: Int) -> [String: JSONValue] {
    ["schemaVersion": .number(1), "operation": .string(operation), "intentHash": .string(trial.intentHash!),
      "descriptorHash": .string(trial.descriptor.descriptorHash), "generationId": trial.collection!["generationId"]!,
      "reservationRevision": .number(Double(revision)), "inflightEpoch": .number(Double(trial.inflightEpoch!))]
  }

  func validateObservationEcho(_ bytes: Data, trial: ArkProtectedTrialState, kind: String, revision: Int, extra: Set<String>) throws -> [String: JSONValue] {
    try ArkProtectedStrictJSON.validate(bytes)
    let definition = kind == "fixed-trial-next-slot-capture-v1" ? "CaptureNextOutput" : kind == "fixed-trial-uncosted-captures-v1" ? "CaptureOutput" : "AssemblerOutput"
    try ArkProtectedObservationSchema.validate(JSONDecoder().decode(JSONValue.self, from: bytes), named: definition)
    let fields = try ArkProtectedBytes.object(bytes, keys: Set(["schemaVersion", "kind", "intentHash", "descriptorHash", "generationId", "reservationRevision", "inflightEpoch"]).union(extra))
    let input = observationInput(trial, operation: "", revision: revision)
    guard fields["kind"] == .string(kind), ["schemaVersion", "intentHash", "descriptorHash", "generationId", "reservationRevision", "inflightEpoch"].allSatisfy({ fields[$0] == input[$0] }) else {
      throw ArkProtectedOwnerError.rejected("Observation helper echo differs")
    }
    return fields
  }

  public func captureNextCompletedRegisteredSlot(_ bytes: Data, trustedAppControl: Bool = false) async throws -> Data {
    let (hash, expected) = try ArkProtectedObservation.request(bytes, operation: "captureNextCompletedRegisteredSlot")
    let (index, initial, evaluator) = try observationTrial(hash, revision: expected)
    guard initial.collection?["phase"] == .string("collecting"),
      let cursor = initial.collection?["nextSlotIndex"]?.jsonSafeInteger(), cursor < initial.descriptor.sessionIDs.count,
      (trustedAppControl || ownedSlotJoins[initial.descriptor.sessionIDs[cursor]] != nil) else {
      throw ArkProtectedOwnerError.rejected("Current owned slot has not joined, already captured, or capture active")
    }
    var reserved = initial
    reserved.inflightEpoch = (initial.inflightEpoch ?? 0) + 1
    var collection = reserved.collection!.objectValue!
    collection["phase"] = .string("slot-reserved"); collection["reservationRevision"] = .number(Double(expected + 1))
    collection["inflightEpoch"] = .number(Double(reserved.inflightEpoch!)); reserved.collection = .object(collection)
    var trials = store.trials; trials[index] = reserved; try store.replace(trials)
    let reservation = store.revision
    var input = observationInput(reserved, operation: "captureNextCompletedRegisteredSlotV1", revision: reservation)
    input["slotIndex"] = .number(Double(cursor))
    let output = try await evaluator.observation(.object(input))
    try observationFence(reserved, revision: reservation)
    let fields = try validateObservationEcho(output, trial: reserved, kind: "fixed-trial-next-slot-capture-v1", revision: reservation, extra: ["slotIndex", "slot"])
    guard fields["slotIndex"] == .number(Double(cursor)), let slot = fields["slot"],
      slot["sessionId"] == .string(initial.descriptor.sessionIDs[cursor]), let outcome = slot["outcome"]?.stringValue,
      ["complete", "incomplete", "cancelled", "invalid-source", "unreadable-source"].contains(outcome),
      (outcome == "complete" ? slot["capture"] != .null && slot["reason"] == .null : slot["capture"] == .null && slot["reason"] != .null) else {
      throw ArkProtectedOwnerError.rejected("Current slot capture identity or outcome differs")
    }
    let (_, currentIntent) = try evaluator.admissionIntent()
    let declaredSlot = currentIntent["core"]!["orderedSlots"]!.arrayValue![cursor]
    guard ["pairId", "role", "useId", "sessionId", "turn"].allSatisfy({ slot[$0] == declaredSlot[$0] }) else {
      throw ArkProtectedOwnerError.rejected("Captured slot differs from ordered pre-registration")
    }
    if outcome == "complete" {
      let ref = slot["capture"]!["taskProjectionBytes"]!
      let root = currentIntent["core"]!["artifactRoot"]!.stringValue!
      let projectionBytes = try ArkProtectedRuntimePins.read(URL(fileURLWithPath: root).appendingPathComponent(ref["hash"]!.stringValue!), hash: ref["hash"]!.stringValue!)
      guard projectionBytes.count == ref["byteLength"]!.jsonSafeInteger() else { throw ArkProtectedOwnerError.rejected("Projection byte length differs") }
      try ArkProtectedStrictJSON.validate(projectionBytes)
      let projection = try JSONDecoder().decode(JSONValue.self, from: projectionBytes)
      try ArkProtectedObservationSchema.validate(projection, named: "FrozenTaskProjection")
      guard projection["intentHash"] == .string(reserved.intentHash!), projection["descriptorHash"] == .string(hash),
        projection["generationId"] == collection["generationId"], projection["slotIndex"] == .number(Double(cursor)),
        projection["sessionId"] == declaredSlot["sessionId"], projection["logicalProjectRoot"] == currentIntent["core"]!["projectRoot"],
        projection["physicalRelativeRoot"] == .string("trial-generations/\(collection["generationId"]!.stringValue!)/\(declaredSlot["allocatedTaskProjectionRelativeRoot"]!.stringValue!)") else {
        throw ArkProtectedOwnerError.rejected("Projection is not the owner allocated physical slot")
      }
    }
    try prepareNativeObservationArtifact(output, root: currentIntent["core"]!["artifactRoot"]!.stringValue!, generation: collection["generationId"]!.stringValue!, copyToOwner: true, additionalPhysicalBytes: output.count)
    let artifactHash = try store.putArtifact(output)
    var captures = collection["orderedCaptures"]!.arrayValue!
    captures.append(.object(["slotIndex": .number(Double(cursor)), "sessionId": slot["sessionId"]!,
      "captureArtifactHash": .string(artifactHash), "captureOutcome": .string(outcome)]))
    collection["orderedCaptures"] = .array(captures); collection["nextSlotIndex"] = .number(Double(cursor + 1))
    collection["phase"] = .string(cursor + 1 == initial.descriptor.sessionIDs.count ? "collected" : "collecting")
    collection["reservationRevision"] = .null
    // Prepared markers are not publication. The sole cursor CAS below makes
    // them authoritative; collect requires the exact retained state hash.
    let root = currentIntent["core"]!["artifactRoot"]!.stringValue!
    try ArkProtectedObservationFiles.publish(output, root: root,
      relative: "trial-generations/\(collection["generationId"]!.stringValue!)/committed-captures/slot-\(cursor).json")
    try observationFence(reserved, revision: reservation)
    reserved.collection = .object(collection); trials[index] = reserved; try store.replace(trials)
    let response: JSONValue = .object(["schemaVersion": .number(1), "descriptorHash": .string(hash),
      "generationId": collection["generationId"]!, "slotIndex": .number(Double(cursor)), "status": .string(outcome == "complete" ? "captured" : "incomplete"),
      "ownerRevision": .number(Double(store.revision)), "captureArtifactHash": .string(artifactHash), "reason": outcome == "complete" ? .null : .string("capture-incomplete")])
    return try ArkProtectedBytes.encode(response)
  }
  public func freezeRegisteredTrial(_ bytes: Data, trustedAppControl: Bool = false) async throws -> Data {
    let (hash, expected) = try ArkProtectedObservation.request(bytes, operation: "freezeRegisteredTrial")
    let (index, initial, evaluator) = try observationTrial(hash, revision: expected)
    guard initial.collection?["phase"] == .string("collected"),
      (trustedAppControl || (ownedGuardJoin != nil && initial.descriptor.sessionIDs.allSatisfy({ ownedSlotJoins[$0] != nil }))), let costOwner else {
      throw ArkProtectedOwnerError.rejected("All owned slots and guard must join before freeze")
    }
    let (_, intent) = try evaluator.admissionIntent()
    let root = intent["core"]!["artifactRoot"]!.stringValue!
    let generation = initial.collection!["generationId"]!.stringValue!
    let captures = initial.collection!["orderedCaptures"]!.arrayValue!
    for (slotIndex, capture) in captures.enumerated() {
      let marker = URL(fileURLWithPath: root).appendingPathComponent("trial-generations/\(initial.collection!["generationId"]!.stringValue!)/committed-captures/slot-\(slotIndex).json")
      _ = try ArkProtectedRuntimePins.read(marker, hash: capture["captureArtifactHash"]!.stringValue!)
    }
    var reserved = initial; reserved.inflightEpoch = (initial.inflightEpoch ?? 0) + 1
    reserved.freeze = .object(["generationId": initial.collection!["generationId"]!, "phase": .string("reserved"),
      "reservationRevision": .number(Double(expected + 1)), "inflightEpoch": .number(Double(reserved.inflightEpoch!)),
      "evidenceHash": .null, "completedConfigHash": .null, "reason": .null, "completedLaunchHash": .null])
    var trials = store.trials; trials[index] = reserved; try store.replace(trials)
    let revision = store.revision
    let collectedBytes = try await evaluator.observation(.object(observationInput(reserved, operation: "collectFrozenRegisteredSlotsV1", revision: revision)))
    try observationFence(reserved, revision: revision)
    let collected = try validateObservationEcho(collectedBytes, trial: reserved, kind: "fixed-trial-uncosted-captures-v1", revision: revision, extra: ["orderedSlots"])
    guard let slots = collected["orderedSlots"]?.arrayValue, slots.count == initial.descriptor.sessionIDs.count,
      slots.enumerated().allSatisfy({ $0.element["sessionId"] == .string(initial.descriptor.sessionIDs[$0.offset]) }) else {
      throw ArkProtectedOwnerError.rejected("Collected slots differ from complete registration")
    }
    let captureHash = try publishObservationArtifact(collectedBytes, root: root, generation: generation)
    var costs: [JSONValue] = []
    for slot in slots {
      let capture = slot["capture"]
      let snapshot = capture?["originalSnapshot"]?["hash"] ?? .null
      let requests = capture?["capturedRequestHashes"] ?? .array([])
      var cost: [String: JSONValue] = ["sessionId": slot["sessionId"]!, "sessionSnapshotHash": snapshot,
        "capturedRequestHashes": requests, "status": .string("unavailable"), "witnessBytes": .null,
        "registrationArtifactHashes": .array([]), "settlementArtifactHashes": .array([]), "reason": .string("incomplete-capture")]
      if slot["outcome"] == .string("complete"), let snapshotHash = snapshot.stringValue {
        let sessionID = slot["sessionId"]!.stringValue!
        let payload: JSONValue = .object(["schemaVersion": .number(1), "operation": .string("resolve-settled-use-cost-v1"),
          "sessionId": .string(sessionID), "sessionSnapshotHash": .string(snapshotHash), "capturedRequestHashes": requests])
        // CaptureOutput was independently produced by the fixed helper from complete
        // durable bytes; cost coverage is the exact original dispatch/attempt set.
        let result = try costOwner.resolveCaptured(payload, descriptor: initial.descriptor, captured: .object([
          "sessionIdHash": .string(ArkProtectedCostOwner.sessionHash(sessionID)), "sessionSnapshotHash": .string(snapshotHash), "capturedRequestHashes": requests]), prepareArtifact: { bytes in
          try self.prepareNativeObservationArtifact(bytes, root: root, generation: generation, copyToOwner: true)
        })
        if result["status"] == .string("verified"), let base64 = result["artifactBytesBase64"]?.stringValue,
          let witness = Data(base64Encoded: base64), let artifactHash = result["artifactHash"]?.stringValue,
          ArkProtectedBytes.digest(witness) == artifactHash,
          let witnessValue = try JSONDecoder().decode(JSONValue.self, from: witness).objectValue,
          let attempts = witnessValue["attempts"]?.arrayValue {
          _ = try publishObservationArtifact(witness, root: root, generation: generation)
          // Original registration/settlement refs live in the same owner store.
          for entry in store.costEntries where entry["registration"]?["sessionIdHash"] == .string(ArkProtectedCostOwner.sessionHash(sessionID)) {
            let registration = try ArkProtectedBytes.encode(entry["registration"]!)
            _ = try publishObservationArtifact(registration, root: root, generation: generation)
            for attempt in entry["attempts"]?.arrayValue ?? [] {
              if var settlement = attempt["settlement"]?.objectValue {
                settlement["kind"] = .string("settled-provider-attempt-v1")
                settlement["sourceBindingHash"] = .string(initial.descriptor.sourceBindingHash)
                _ = try publishObservationArtifact(ArkProtectedBytes.encode(JSONValue.object(settlement)), root: root, generation: generation)
              }
            }
          }
          cost["status"] = .string("verified"); cost["reason"] = .null
          cost["witnessBytes"] = .object(["hash": .string(artifactHash), "byteLength": .number(Double(witness.count))])
          cost["registrationArtifactHashes"] = .array(attempts.map { $0["registrationArtifactHash"]! })
          cost["settlementArtifactHashes"] = .array(attempts.map { $0["settlementArtifactHash"]! })
        } else { cost["status"] = .string("unknown"); cost["reason"] = .string("missing-dispatch") }
      }
      costs.append(.object(cost))
    }
    try observationFence(reserved, revision: revision)
    let costResolution: JSONValue = .object(["schemaVersion": .number(1), "kind": .string("fixed-trial-native-cost-resolution-v1"),
      "intentHash": .string(initial.intentHash!), "descriptorHash": .string(hash), "generationId": initial.collection!["generationId"]!,
      "reservationRevision": .number(Double(revision)), "orderedSlots": .array(costs)])
    let costHash = try publishObservationArtifact(ArkProtectedBytes.encode(costResolution), root: root, generation: generation)
    var assemblyInput = observationInput(reserved, operation: "assembleFrozenTrialConfigV1", revision: revision)
    assemblyInput["captureOutputHash"] = .string(captureHash); assemblyInput["costResolutionHash"] = .string(costHash)
    let assemblyBytes = try await evaluator.observation(.object(assemblyInput))
    try observationFence(reserved, revision: revision)
    let assembly = try validateObservationEcho(assemblyBytes, trial: reserved, kind: "fixed-trial-completed-config-v1", revision: revision,
      extra: ["status", "completedConfigBytes", "orderedRegisteredManifestHashes", "orderedCostWitnessHashes", "completedLaunchBytes"])
    let complete = assembly["status"] == .string("complete")
    guard !complete || (slots.allSatisfy({ $0["outcome"] == .string("complete") }) && costs.allSatisfy({ $0["status"] == .string("verified") })) else {
      throw ArkProtectedOwnerError.rejected("Native unknown cost or incomplete slot cannot become eligible")
    }
    let assembledWitnesses = assembly["orderedCostWitnessHashes"]!.arrayValue!
    guard complete ? assembledWitnesses == costs.map({ $0["witnessBytes"]!["hash"]! }) : assembledWitnesses.isEmpty else {
      throw ArkProtectedOwnerError.rejected("Assembled witness ordering differs from native costs")
    }
    let configHash = assembly["completedConfigBytes"]?["hash"] ?? .null
    let launchHash = assembly["completedLaunchBytes"]?["hash"] ?? .null
    guard complete ? configHash.stringValue.map(ArkProtectedBytes.hashIsValid) == true && launchHash.stringValue.map(ArkProtectedBytes.hashIsValid) == true
      : assembly["status"] == .string("ineligible-observation") && configHash == .null && launchHash == .null else {
      throw ArkProtectedOwnerError.rejected("Assembled eligibility and launch differ")
    }
    var retainedEvaluator: ArkProtectedEvaluator?
    if complete {
      for ref in [assembly["completedConfigBytes"]!, assembly["completedLaunchBytes"]!] {
        let bytes = try ArkProtectedRuntimePins.read(URL(fileURLWithPath: root).appendingPathComponent(ref["hash"]!.stringValue!), hash: ref["hash"]!.stringValue!)
        guard bytes.count == ref["byteLength"]!.jsonSafeInteger() else { throw ArkProtectedOwnerError.rejected("Completed config or launch length differs") }
      }
      let candidate = try evaluator.completedEvaluator(launchHash: launchHash.stringValue!, artifactRoot: root)
      guard try await candidate.descriptor() == initial.descriptor else { throw ArkProtectedOwnerError.rejected("Completed descriptor differs from admission intent") }
      try observationFence(reserved, revision: revision)
      retainedEvaluator = candidate
    }
    let manifests = assembly["orderedRegisteredManifestHashes"]!.arrayValue!
    guard complete ? manifests.count == slots.count : manifests.isEmpty else { throw ArkProtectedOwnerError.rejected("Assembled slot cardinality differs") }
    var frozenSlots: [JSONValue] = []
    for (slotIndex, slot) in slots.enumerated() {
      let capture = slot["capture"]
      frozenSlots.append(.object(["pairId": slot["pairId"]!, "role": slot["role"]!, "useId": slot["useId"]!, "sessionId": slot["sessionId"]!,
        "turn": slot["turn"]!, "captureOutcome": slot["outcome"]!, "originalSnapshotHash": capture?["originalSnapshot"]?["hash"] ?? .null,
        "captureFactsHash": capture?["captureFactsBytes"]?["hash"] ?? .null, "wholeOutputHash": capture?["wholeOutputUtf8Bytes"]?["hash"] ?? .null,
        "actualTaskFiles": capture?["actualTaskFiles"] ?? .array([]), "capturedRequestHashes": capture?["capturedRequestHashes"] ?? .array([]),
        "costStatus": costs[slotIndex]["status"]!, "costWitnessHash": costs[slotIndex]["witnessBytes"]?["hash"] ?? .null,
        "registeredManifestHash": complete ? manifests[slotIndex] : .null, "retainedOriginalBytes": slot["retainedOriginalBytes"]!,
        "taskProjectionHash": capture?["taskProjectionBytes"]?["hash"] ?? .null]))
    }
    let evidence: JSONValue = .object(["schemaVersion": .number(1), "kind": .string("fixed-trial-frozen-observations-v1"),
      "intentHash": .string(initial.intentHash!), "descriptorHash": .string(hash), "generationId": initial.collection!["generationId"]!,
      "admissionEpoch": .number(Double(initial.admissionEpoch!)), "reservationRevision": .number(Double(revision)),
      "captureOutputHash": .string(captureHash), "costResolutionHash": .string(costHash), "completedConfigHash": configHash,
      "orderedSlots": .array(frozenSlots), "status": assembly["status"]!, "completedLaunchHash": launchHash])
    let evidenceHash = try publishObservationArtifact(ArkProtectedBytes.encode(evidence), root: root, generation: generation)
    try observationFence(reserved, revision: revision)
    var freeze = reserved.freeze!.objectValue!
    freeze["phase"] = .string(complete ? "frozen" : "failed"); freeze["evidenceHash"] = .string(evidenceHash)
    freeze["completedConfigHash"] = configHash; freeze["completedLaunchHash"] = launchHash
    freeze["reason"] = complete ? .null : .string(slots.contains(where: { $0["outcome"] != .string("complete") }) ? "capture-incomplete" : "cost-unknown")
    reserved.freeze = .object(freeze); trials[index] = reserved; try store.replace(trials)
    completedEvaluator = retainedEvaluator
    return try ArkProtectedBytes.encode(JSONValue.object(["schemaVersion": .number(1), "descriptorHash": .string(hash),
      "generationId": freeze["generationId"]!, "status": .string(complete ? "frozen" : "failed"), "ownerRevision": .number(Double(store.revision)),
      "evidenceHash": .string(evidenceHash), "completedConfigHash": configHash, "completedLaunchHash": launchHash, "reason": freeze["reason"]!]))
  }

  /// Original producer read-only cost resolution remains available after freeze;
  /// its finite reservation survives cancellation/restart without a refund.
  func resolveFrozenCost(_ payload: JSONValue, trial: ArkProtectedTrialState, costOwner: ArkProtectedCostOwner) async throws -> JSONValue {
    guard let evaluator = completedEvaluator, let session = payload["sessionId"]?.stringValue,
      trial.descriptor.sessionIDs.contains(session), let snapshot = payload["sessionSnapshotHash"]?.stringValue else {
      throw ArkProtectedOwnerError.rejected("Frozen resolver is not pinned to completed capture")
    }
    let digest = ArkProtectedBytes.digest(try ArkProtectedBytes.encode(JSONValue.object(["operation": .string("resolveSettledUseCost"), "payload": payload])))
    var trials = store.trials
    let index = trials.firstIndex(where: { $0.descriptor == trial.descriptor })!
    guard !trials[index].reservations.contains(where: { $0.requestDigest == digest }),
      trials[index].reservations.filter({ $0.operation == .resolveSettledUseCost }).count < (trial.descriptor.operationLimits["resolveSettledUseCost"] ?? 0),
      trials[index].reservations.count < 8192 else { throw ArkProtectedOwnerError.rejected("Frozen cost resolver limit was reserved or spent") }
    trials[index].reservations.append(ArkProtectedReservation(requestDigest: digest, operation: .resolveSettledUseCost, phase: "reserved"))
    try store.replace(trials)
    let revision = store.revision
    guard try await evaluator.descriptor() == trial.descriptor else { throw ArkProtectedOwnerError.rejected("Frozen descriptor changed") }
    try observationFence(trials[index], revision: revision)
    let captured = try await evaluator.capturedCostUse(sessionID: session, snapshotHash: snapshot)
    try observationFence(trials[index], revision: revision)
    let (_, retainedIntent) = try observationEvaluator!.admissionIntent()
    let retainedRoot = retainedIntent["core"]!["artifactRoot"]!.stringValue!, retainedGeneration = trial.collection!["generationId"]!.stringValue!
    let result = try costOwner.resolveCaptured(payload, descriptor: trial.descriptor, captured: captured, prepareArtifact: { bytes in
      try self.prepareNativeObservationArtifact(bytes, root: retainedRoot, generation: retainedGeneration, copyToOwner: true)
    })
    guard result["status"] == .string("verified") else { return result }
    // Witness hash is fixed by the committed original config; a new witness is
    // never substituted after freeze, even if all caller coverage fields match.
    let (_, intent) = try observationEvaluator!.admissionIntent()
    let root = intent["core"]!["artifactRoot"]!.stringValue!
    let configHash = trial.freeze!["completedConfigHash"]!.stringValue!
    let configBytes = try ArkProtectedRuntimePins.read(URL(fileURLWithPath: root).appendingPathComponent(configHash), hash: configHash)
    let config = try JSONDecoder().decode(JSONValue.self, from: configBytes)
    guard let registration = config["registrations"]?.arrayValue?.first(where: { $0["binding"]?["sessionId"] == .string(session) }),
      registration["costWitnessHash"] == result["artifactHash"] else { throw ArkProtectedOwnerError.rejected("Frozen witness replacement refused") }
    let reservation = trials[index].reservations.firstIndex(where: { $0.requestDigest == digest })!
    trials[index].reservations[reservation].phase = "spent"; try store.replace(trials)
    return result
  }

  func observationFailureAudit(_ trial: ArkProtectedTrialState) throws -> String {
    guard let evaluator = observationEvaluator, let collection = trial.collection, let intentHash = trial.intentHash else {
      throw ArkProtectedOwnerError.rejected("Observation failure audit unavailable")
    }
    let (_, intent) = try evaluator.admissionIntent()
    let root = intent["core"]!["artifactRoot"]!.stringValue!
    let slots = intent["core"]!["orderedSlots"]!.arrayValue!
    let committed = collection["orderedCaptures"]!.arrayValue!
    var outcomes: [JSONValue] = []
    for (slotIndex, slot) in slots.enumerated() {
      if slotIndex < committed.count {
        let marker = URL(fileURLWithPath: root).appendingPathComponent("trial-generations/\(collection["generationId"]!.stringValue!)/committed-captures/slot-\(slotIndex).json")
        let bytes = try ArkProtectedRuntimePins.read(marker, hash: committed[slotIndex]["captureArtifactHash"]!.stringValue!)
        try ArkProtectedStrictJSON.validate(bytes)
        let capture = try JSONDecoder().decode(JSONValue.self, from: bytes)
        try ArkProtectedObservationSchema.validate(capture, named: "CaptureNextOutput")
        outcomes.append(capture["slot"]!)
      } else {
        let potentiallyStarted = slotIndex == committed.count && trial.phase == "admitted"
        outcomes.append(.object(["pairId": slot["pairId"]!, "role": slot["role"]!, "useId": slot["useId"]!, "sessionId": slot["sessionId"]!,
          "turn": slot["turn"]!, "outcome": .string(potentiallyStarted ? "incomplete" : "not-run"),
          "reason": .string(potentiallyStarted ? "turn-not-completed" : "slot-not-run"), "retainedOriginalBytes": .array([]), "capture": .null]))
      }
    }
    let output: JSONValue = .object(["schemaVersion": .number(1), "kind": .string("fixed-trial-uncosted-captures-v1"),
      "intentHash": .string(intentHash), "descriptorHash": .string(trial.descriptor.descriptorHash), "generationId": collection["generationId"]!,
      "reservationRevision": .number(Double(store.revision)), "inflightEpoch": collection["inflightEpoch"]!, "orderedSlots": .array(outcomes)])
    try ArkProtectedObservationSchema.validate(output, named: "CaptureOutput")
    return try publishObservationArtifact(ArkProtectedBytes.encode(output), root: root, generation: collection["generationId"]!.stringValue!)
  }

  /// Accounts both content-addressed bytes and distinct physical snapshot/task
  /// copies before Native adds aggregate/cost/config/evidence artifacts.
  func requireObservationPreparedBudget(_ bytes: Data, root: String, generation: String, targetRoot: String? = nil, additionalPhysicalBytes: Int = 0) throws {
    let maximum = 64 * 1024 * 1024
    guard let evaluator = observationEvaluator,
      let trial = store.trials.first(where: { $0.collection?["generationId"] == .string(generation) }) else {
      throw ArkProtectedOwnerError.rejected("Prepared budget generation is not retained by owner")
    }
    let (_, intent) = try evaluator.admissionIntent()
    var refs = observationPreparedArtifacts[generation] ?? [:]
    func add(_ hash: String, _ count: Int) throws {
      guard ArkProtectedBytes.hashIsValid(hash), count >= 0, count <= 16 * 1024 * 1024,
        refs[hash] == nil || refs[hash] == count else { throw ArkProtectedOwnerError.rejected("Prepared byte reference differs") }
      refs[hash] = count
    }
    func inspect(_ value: JSONValue) throws {
      if let object = value.objectValue {
        if Set(object.keys) == ["hash", "byteLength"], let hash = object["hash"]?.stringValue, let count = object["byteLength"]?.jsonSafeInteger() {
          try add(hash, count)
        } else { for nested in object.values { try inspect(nested) } }
      } else if let array = value.arrayValue { for nested in array { try inspect(nested) } }
    }
    try inspect(intent)
    for (slotIndex, capture) in trial.collection?["orderedCaptures"]?.arrayValue?.enumerated() ?? [].enumerated() {
      let path = URL(fileURLWithPath: root).appendingPathComponent("trial-generations/\(generation)/committed-captures/slot-\(slotIndex).json")
      let retained = try ArkProtectedRuntimePins.read(path, hash: capture["captureArtifactHash"]!.stringValue!)
      try inspect(JSONDecoder().decode(JSONValue.self, from: retained))
      try add(capture["captureArtifactHash"]!.stringValue!, retained.count)
    }
    if let value = try? JSONDecoder().decode(JSONValue.self, from: bytes) { try inspect(value) }
    try add(ArkProtectedBytes.digest(bytes), bytes.count)
    let maximumDepth = 1024
    let maximumEntries = 32 * (2 * 4096 + 66 * maximumDepth + 32)
    var physicalBytes = 0, entries = 0
    func visit(_ path: URL, depth: Int = 0) throws {
      try Task.checkCancellation()
      entries += 1
      guard entries <= maximumEntries, depth <= maximumDepth else { throw ArkProtectedOwnerError.rejected("Prepared physical trial tree exceeds entry/depth bound") }
      var info = stat()
      guard lstat(path.path, &info) == 0 else {
        if errno == ENOENT { return }; throw ArkProtectedOwnerError.rejected("Prepared physical artifact disappeared")
      }
      if info.st_mode & S_IFMT == S_IFDIR {
        for name in try FileManager.default.contentsOfDirectory(atPath: path.path) { try visit(path.appendingPathComponent(name), depth: depth + 1) }
      } else {
        guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1, info.st_uid == getuid(), info.st_size >= 0, info.st_size <= 16 * 1024 * 1024 else {
          throw ArkProtectedOwnerError.rejected("Prepared physical artifact is not an ordinary bounded file")
        }
        if ["prepared-artifacts", "prepared-owner-artifacts"].contains(path.deletingLastPathComponent().lastPathComponent), ArkProtectedBytes.hashIsValid(path.lastPathComponent) {
          _ = try ArkProtectedRuntimePins.read(path, hash: path.lastPathComponent)
          try add(path.lastPathComponent, Int(info.st_size))
        }
        physicalBytes += Int(info.st_size)
        guard physicalBytes <= maximum else { throw ArkProtectedOwnerError.rejected("Prepared physical trial bytes exceed bound") }
      }
    }
    try visit(URL(fileURLWithPath: root).appendingPathComponent("trial-generations/" + generation))
    var contentBytes = 0
    let nextHash = ArkProtectedBytes.digest(bytes)
    for (hash, expectedLength) in refs {
      var copies = 0
      for selectedRoot in Set([root, store.rootPath]) {
        let path = URL(fileURLWithPath: selectedRoot).appendingPathComponent(hash)
        var info = stat()
        if lstat(path.path, &info) == 0 {
          guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1, info.st_size == expectedLength else {
            throw ArkProtectedOwnerError.rejected("Prepared content artifact type or length differs")
          }
          copies += 1
        } else if errno != ENOENT { throw ArkProtectedOwnerError.rejected("Prepared content artifact is unreadable") }
      }
      if hash == nextHash {
        var info = stat()
        if lstat(URL(fileURLWithPath: targetRoot ?? root).appendingPathComponent(hash).path, &info) != 0 { copies += 1 }
      }
      guard copies > 0 else { throw ArkProtectedOwnerError.rejected("Prepared reference has no actual or reserved content bytes") }
      contentBytes += copies * expectedLength
    }
    guard additionalPhysicalBytes >= 0, contentBytes + physicalBytes + additionalPhysicalBytes <= maximum else {
      throw ArkProtectedOwnerError.rejected("Prepared trial artifacts exceed 64MiB bound")
    }
    observationPreparedArtifacts[generation] = refs
  }

  /// Raw bookkeeping is shared with the fixed helper. Owner-copy records charge
  /// the separate private store before allocation; no JSON/state/wire is added.
  func prepareNativeObservationArtifact(_ bytes: Data, root: String, generation: String, copyToOwner: Bool, additionalPhysicalBytes: Int = 0) throws {
    let hash = ArkProtectedBytes.digest(bytes)
    let shared = "trial-generations/\(generation)/prepared-artifacts/\(hash)"
    let owner = "trial-generations/\(generation)/prepared-owner-artifacts/\(hash)"
    let separateOwner = copyToOwner && root != store.rootPath
    var additional = additionalPhysicalBytes
    for relative in [shared] + (separateOwner ? [owner] : []) {
      if !FileManager.default.fileExists(atPath: URL(fileURLWithPath: root).appendingPathComponent(relative).path) { additional += bytes.count }
    }
    if separateOwner && !FileManager.default.fileExists(atPath: URL(fileURLWithPath: store.rootPath).appendingPathComponent(hash).path) { additional += bytes.count }
    try requireObservationPreparedBudget(bytes, root: root, generation: generation, additionalPhysicalBytes: additional)
    for relative in [shared] + (separateOwner ? [owner] : []) {
      let path = URL(fileURLWithPath: root).appendingPathComponent(relative)
      if FileManager.default.fileExists(atPath: path.path) {
        guard try ArkProtectedRuntimePins.read(path, hash: hash) == bytes else { throw ArkProtectedOwnerError.rejected("Prepared Native raw copy changed") }
      } else { try ArkProtectedObservationFiles.publish(bytes, root: root, relative: relative) }
    }
    let content = URL(fileURLWithPath: root).appendingPathComponent(hash)
    if FileManager.default.fileExists(atPath: content.path) {
      guard try ArkProtectedRuntimePins.read(content, hash: hash) == bytes else { throw ArkProtectedOwnerError.rejected("Prepared Native content copy changed") }
    } else { try ArkProtectedObservationFiles.publish(bytes, root: root, relative: hash) }
  }

  func publishObservationArtifact(_ bytes: Data, root: String, generation: String) throws -> String {
    try prepareNativeObservationArtifact(bytes, root: root, generation: generation, copyToOwner: false)
    let hash = ArkProtectedBytes.digest(bytes)
    let path = URL(fileURLWithPath: root).appendingPathComponent(hash)
    if FileManager.default.fileExists(atPath: path.path) {
      guard try ArkProtectedRuntimePins.read(path, hash: hash) == bytes else { throw ArkProtectedOwnerError.rejected("Observation artifact changed") }
    } else { try ArkProtectedObservationFiles.publish(bytes, root: root, relative: hash) }
    return hash
  }

}

/// Owner-only exclusive files, confined through no-follow directory descriptors.
enum ArkProtectedObservationFiles {
  static func publish(_ bytes: Data, root: String, relative: String) throws {
    let components = relative.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard !components.isEmpty, components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") && !$0.contains("\0") }) else {
      throw ArkProtectedOwnerError.rejected("Unsafe observation artifact path")
    }
    var directory = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard directory >= 0 else { throw ArkProtectedOwnerError.rejected("Cannot open artifact root") }
    defer { Darwin.close(directory) }
    for component in root.split(separator: "/").map(String.init) + components.dropLast() {
      if mkdirat(directory, component, 0o700) != 0 && errno != EEXIST { throw ArkProtectedOwnerError.rejected("Cannot create confined observation directory") }
      let next = openat(directory, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard next >= 0 else { throw ArkProtectedOwnerError.rejected("Unsafe observation directory") }
      Darwin.close(directory); directory = next
    }
    let file = openat(directory, components.last!, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard file >= 0 else { throw ArkProtectedOwnerError.rejected("Observation artifact already exists or is unsafe") }
    defer { Darwin.close(file) }
    try FileHandle(fileDescriptor: file, closeOnDealloc: false).write(contentsOf: bytes)
    guard fsync(file) == 0, fsync(directory) == 0 else { throw ArkProtectedOwnerError.rejected("Observation artifact commit failed") }
  }
}
