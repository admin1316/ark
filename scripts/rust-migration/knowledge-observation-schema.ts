/** Approved V3 private schema source of record; generated verbatim from the frozen reviewed schema. */
import z from 'zod'

const definitions = {
  'Hash': {
    'type': 'string',
    'pattern': '^[a-f0-9]{64}$',
  },
  'Id': {
    'type': 'string',
    'minLength': 1,
    'maxLength': 160,
  },
  'AbsolutePath': {
    'type': 'string',
    'minLength': 1,
    'maxLength': 4096,
    'pattern': '^/[^\\u0000]*$',
  },
  'RelativePath': {
    'type': 'string',
    'minLength': 1,
    'maxLength': 1024,
    'pattern': '^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\u0000]+$',
  },
  'Utc': {
    'type': 'string',
    'pattern': '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
  },
  'BlobRef': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'hash',
      'byteLength',
    ],
    'properties': {
      'hash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'byteLength': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 16777216,
      },
    },
  },
  'SourceIdentity': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'commit',
      'sourceDigest',
      'dirty',
      'dirtyDigest',
      'buildDigest',
    ],
    'properties': {
      'commit': {
        'type': 'string',
        'pattern': '^[a-f0-9]{40}$',
      },
      'sourceDigest': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'dirty': {
        'type': 'boolean',
      },
      'dirtyDigest': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'buildDigest': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
    },
  },
  'Authority': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'authorityId',
      'publicKeySpkiBase64',
    ],
    'properties': {
      'authorityId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'publicKeySpkiBase64': {
        'type': 'string',
        'pattern': '^[A-Za-z0-9+/]{59}=$',
      },
    },
  },
  'Authorities': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'promotion',
      'journal',
      'evaluator',
      'costAuthorityId',
      'producerId',
    ],
    'properties': {
      'promotion': {
        '$ref': '#/$defs/Authority',
      },
      'journal': {
        '$ref': '#/$defs/Authority',
      },
      'evaluator': {
        '$ref': '#/$defs/Authority',
      },
      'costAuthorityId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'producerId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
    },
  },
  'FrozenInput': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'path',
      'bytes',
    ],
    'properties': {
      'path': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 1024,
        'pattern': '^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\u0000]+$',
      },
      'bytes': {
        '$ref': '#/$defs/BlobRef',
      },
    },
  },
  'SingleLineTask': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'kind',
      'terms',
    ],
    'properties': {
      'kind': {
        'const': 'single-line-v1',
      },
      'terms': {
        '$ref': '#/$defs/FrozenInput',
      },
    },
  },
  'InvoiceTask': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'kind',
      'invoices',
      'rates',
    ],
    'properties': {
      'kind': {
        'const': 'invoice-v1',
      },
      'invoices': {
        '$ref': '#/$defs/FrozenInput',
      },
      'rates': {
        '$ref': '#/$defs/FrozenInput',
      },
    },
  },
  'PaginationTask': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'kind',
      'codePath',
      'protectedFiles',
      'timeoutMs',
      'initialCodeBytes',
    ],
    'properties': {
      'kind': {
        'const': 'pagination-v1',
      },
      'codePath': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 1024,
        'pattern': '^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\u0000]+$',
      },
      'protectedFiles': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/FrozenInput',
        },
        'minItems': 1,
        'maxItems': 64,
      },
      'timeoutMs': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 120000,
      },
      'initialCodeBytes': {
        '$ref': '#/$defs/BlobRef',
      },
    },
  },
  'TaskDefinition': {
    'oneOf': [
      {
        '$ref': '#/$defs/SingleLineTask',
      },
      {
        '$ref': '#/$defs/InvoiceTask',
      },
      {
        '$ref': '#/$defs/PaginationTask',
      },
    ],
  },
  'Knowledge': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'id',
      'sourceContentBytes',
      'renderedBytes',
    ],
    'properties': {
      'id': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 512,
      },
      'sourceContentBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'renderedBytes': {
        '$ref': '#/$defs/BlobRef',
      },
    },
  },
  'StartFence': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'encoding',
      'originalInitialSnapshotBytes',
      'metadataEnvelopeBytes',
      'eventSequencePrefixBytes',
      'lastEventSeq',
      'expectedTurn',
    ],
    'properties': {
      'encoding': {
        'enum': [
          'jsonl',
          'jsonl-zstd',
        ],
      },
      'originalInitialSnapshotBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'metadataEnvelopeBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'eventSequencePrefixBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'lastEventSeq': {
        'anyOf': [
          {
            'type': 'integer',
            'minimum': 0,
            'maximum': 9007199254740991,
          },
          {
            'type': 'null',
          },
        ],
      },
      'expectedTurn': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 9007199254740991,
      },
    },
  },
  'Slot': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'pairId',
      'role',
      'useId',
      'sessionId',
      'turn',
      'snapshotRelativePath',
      'startFence',
      'grantId',
      'knowledge',
      'registeredVerificationRequestBytes',
      'acceptedRuleHash',
      'taskDefinition',
      'allocatedTaskProjectionRelativeRoot',
    ],
    'properties': {
      'pairId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'role': {
        'enum': [
          'baseline',
          'candidate',
        ],
      },
      'useId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'sessionId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'turn': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 9007199254740991,
      },
      'snapshotRelativePath': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 1024,
        'pattern': '^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\u0000]+$',
      },
      'startFence': {
        '$ref': '#/$defs/StartFence',
      },
      'grantId': {
        'anyOf': [
          {
            'type': 'string',
            'minLength': 1,
            'maxLength': 160,
          },
          {
            'type': 'null',
          },
        ],
      },
      'knowledge': {
        'anyOf': [
          {
            '$ref': '#/$defs/Knowledge',
          },
          {
            'type': 'null',
          },
        ],
      },
      'registeredVerificationRequestBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'acceptedRuleHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'taskDefinition': {
        '$ref': '#/$defs/TaskDefinition',
      },
      'allocatedTaskProjectionRelativeRoot': {
        '$ref': '#/$defs/RelativePath',
      },
    },
  },
  'PromotionPolicy': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'promotionRequestHashes',
      'promotionVerificationManifestHashes',
    ],
    'properties': {
      'promotionRequestHashes': {
        'type': 'array',
        'items': {
          'type': 'string',
          'pattern': '^[a-f0-9]{64}$',
        },
        'minItems': 0,
        'maxItems': 64,
      },
      'promotionVerificationManifestHashes': {
        'type': 'array',
        'items': {
          'type': 'string',
          'pattern': '^[a-f0-9]{64}$',
        },
        'minItems': 0,
        'maxItems': 64,
      },
    },
  },
  'OperationLimits': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'sealPromotion',
      'signKnowledgeUseJournal',
      'verifyCandidate',
      'evaluateCapturedUse',
      'finalizeMeasuredTrial',
      'registerProviderDispatch',
      'recordProviderSettlement',
      'resolveSettledUseCost',
    ],
    'properties': {
      'sealPromotion': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 64,
      },
      'signKnowledgeUseJournal': {
        'type': 'integer',
        'minimum': 2,
        'maximum': 32,
      },
      'verifyCandidate': {
        'type': 'integer',
        'minimum': 2,
        'maximum': 96,
      },
      'evaluateCapturedUse': {
        'type': 'integer',
        'minimum': 2,
        'maximum': 32,
      },
      'finalizeMeasuredTrial': {
        'const': 1,
      },
      'registerProviderDispatch': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 32,
      },
      'recordProviderSettlement': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 32,
      },
      'resolveSettledUseCost': {
        'type': 'integer',
        'minimum': 2,
        'maximum': 32,
      },
    },
  },
  'CostIntent': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'initialLedgerBytes',
      'ledgerPath',
      'endpoint',
      'provider',
      'configuredModel',
      'wireModel',
      'maxTokens',
      'maximumNewDispatches',
      'maximumNewSettlements',
      'guardConfigurationBytes',
    ],
    'properties': {
      'initialLedgerBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'ledgerPath': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 4096,
        'pattern': '^/[^\\u0000]*$',
      },
      'endpoint': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 2048,
      },
      'provider': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'configuredModel': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'wireModel': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'maxTokens': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 8192,
      },
      'maximumNewDispatches': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 32,
      },
      'maximumNewSettlements': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 32,
      },
      'guardConfigurationBytes': {
        '$ref': '#/$defs/BlobRef',
      },
    },
  },
  'Core': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'kind',
      'mode',
      'trialId',
      'packReceiptBytes',
      'installedManifestBytes',
      'runtimeRoot',
      'nodePath',
      'nodeHash',
      'entryRelativePath',
      'entryHash',
      'projectRoot',
      'sessionRoot',
      'artifactRoot',
      'authorities',
      'proposalBytes',
      'grantBytes',
      'preRegistrationBytes',
      'measurementDefinitionBytes',
      'sourceIdentity',
      'buildIdentity',
      'profileIdentity',
      'originalTaskUtf8Bytes',
      'originalConfigCanonicalBytes',
      'originalPermissionsCanonicalBytes',
      'goalHash',
      'policyHash',
      'deadline',
      'expiresAt',
      'orderedPairIds',
      'orderedSlots',
      'promotionPolicy',
      'operationLimits',
      'cost',
      'guardEntryRelativePath',
      'guardEntryHash',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'kind': {
        'const': 'fixed-trial-admission-core-v1',
      },
      'mode': {
        'const': 'ephemeral-test-only',
      },
      'trialId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'packReceiptBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'installedManifestBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'runtimeRoot': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 4096,
        'pattern': '^/[^\\u0000]*$',
      },
      'nodePath': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 4096,
        'pattern': '^/[^\\u0000]*$',
      },
      'nodeHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'entryRelativePath': {
        'const': 'protected-helpers/scripts/rust-migration/knowledge-use-evaluator.mjs',
      },
      'entryHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'projectRoot': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 4096,
        'pattern': '^/[^\\u0000]*$',
      },
      'sessionRoot': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 4096,
        'pattern': '^/[^\\u0000]*$',
      },
      'artifactRoot': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 4096,
        'pattern': '^/[^\\u0000]*$',
      },
      'authorities': {
        '$ref': '#/$defs/Authorities',
      },
      'proposalBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'grantBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'preRegistrationBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'measurementDefinitionBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'sourceIdentity': {
        '$ref': '#/$defs/SourceIdentity',
      },
      'buildIdentity': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'profileIdentity': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'originalTaskUtf8Bytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'originalConfigCanonicalBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'originalPermissionsCanonicalBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'goalHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'policyHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'deadline': {
        '$ref': '#/$defs/Utc',
      },
      'expiresAt': {
        '$ref': '#/$defs/Utc',
      },
      'orderedPairIds': {
        'type': 'array',
        'items': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 160,
        },
        'minItems': 1,
        'maxItems': 16,
      },
      'orderedSlots': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/Slot',
        },
        'minItems': 2,
        'maxItems': 32,
      },
      'promotionPolicy': {
        '$ref': '#/$defs/PromotionPolicy',
      },
      'operationLimits': {
        '$ref': '#/$defs/OperationLimits',
      },
      'cost': {
        '$ref': '#/$defs/CostIntent',
      },
      'guardEntryRelativePath': {
        'const': 'protected-helpers/scripts/rust-migration/knowledge-cost-guard-launcher.mjs',
      },
      'guardEntryHash': {
        '$ref': '#/$defs/Hash',
      },
    },
  },
  'Intent': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'kind',
      'core',
      'sourceBindingHash',
      'liveCostAdmissionBytes',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'kind': {
        'const': 'fixed-trial-admission-intent-v1',
      },
      'core': {
        '$ref': '#/$defs/Core',
      },
      'sourceBindingHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'liveCostAdmissionBytes': {
        '$ref': '#/$defs/BlobRef',
      },
    },
  },
  'FreezeRequest': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'descriptorHash',
      'expectedOwnerRevision',
      'operation',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'descriptorHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'expectedOwnerRevision': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'operation': {
        'const': 'freezeRegisteredTrial',
      },
    },
  },
  'FreezeResponse': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'descriptorHash',
      'generationId',
      'status',
      'ownerRevision',
      'evidenceHash',
      'completedConfigHash',
      'reason',
      'completedLaunchHash',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'descriptorHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'generationId': {
        'anyOf': [
          {
            '$ref': '#/$defs/GenerationId',
          },
          {
            'type': 'null',
          },
        ],
      },
      'status': {
        'enum': [
          'frozen',
          'failed',
          'reserved-uncertain',
          'rejected',
        ],
      },
      'ownerRevision': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'evidenceHash': {
        'anyOf': [
          {
            'type': 'string',
            'pattern': '^[a-f0-9]{64}$',
          },
          {
            'type': 'null',
          },
        ],
      },
      'completedConfigHash': {
        'anyOf': [
          {
            'type': 'string',
            'pattern': '^[a-f0-9]{64}$',
          },
          {
            'type': 'null',
          },
        ],
      },
      'reason': {
        'anyOf': [
          {
            'enum': [
              'stale-revision',
              'not-admitted',
              'expired',
              'revoked',
              'already-freezing',
              'already-frozen',
              'previous-failure',
              'owned-run-not-joined',
              'capture-incomplete',
              'cost-unknown',
              'source-invalid',
              'actor-fence-conflict',
              'cancelled',
              'io-failure',
            ],
          },
          {
            'type': 'null',
          },
        ],
      },
      'completedLaunchHash': {
        'anyOf': [
          {
            '$ref': '#/$defs/Hash',
          },
          {
            'type': 'null',
          },
        ],
      },
    },
  },
  'ArtifactRefList': {
    'type': 'array',
    'items': {
      '$ref': '#/$defs/BlobRef',
    },
    'minItems': 0,
    'maxItems': 4096,
  },
  'UncostedCapture': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'originalSnapshot',
      'frozenSnapshotRelativePath',
      'originalMetadata',
      'captureFactsBytes',
      'journalArtifactBytes',
      'wholeOutputUtf8Bytes',
      'capturedRequestHashes',
      'capturedArtifactBytes',
      'actualTaskFiles',
      'taskProjectionBytes',
    ],
    'properties': {
      'originalSnapshot': {
        '$ref': '#/$defs/BlobRef',
      },
      'frozenSnapshotRelativePath': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 1024,
        'pattern': '^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\u0000]+$',
      },
      'originalMetadata': {
        '$ref': '#/$defs/BlobRef',
      },
      'captureFactsBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'journalArtifactBytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'wholeOutputUtf8Bytes': {
        '$ref': '#/$defs/BlobRef',
      },
      'capturedRequestHashes': {
        'type': 'array',
        'items': {
          'type': 'string',
          'pattern': '^[a-f0-9]{64}$',
        },
        'minItems': 1,
        'maxItems': 32,
      },
      'capturedArtifactBytes': {
        '$ref': '#/$defs/ArtifactRefList',
      },
      'actualTaskFiles': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/FrozenInput',
        },
        'minItems': 0,
        'maxItems': 66,
      },
      'taskProjectionBytes': {
        '$ref': '#/$defs/BlobRef',
      },
    },
  },
  'CaptureSlot': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'pairId',
      'role',
      'useId',
      'sessionId',
      'turn',
      'outcome',
      'reason',
      'retainedOriginalBytes',
      'capture',
    ],
    'properties': {
      'pairId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'role': {
        'enum': [
          'baseline',
          'candidate',
        ],
      },
      'useId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'sessionId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'turn': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 9007199254740991,
      },
      'outcome': {
        'enum': [
          'complete',
          'incomplete',
          'cancelled',
          'invalid-source',
          'unreadable-source',
          'not-run',
        ],
      },
      'reason': {
        'anyOf': [
          {
            'enum': [
              'turn-not-completed',
              'cancelled',
              'identity-mismatch',
              'permission-mismatch',
              'knowledge-mismatch',
              'prefix-mismatch',
              'snapshot-changed',
              'task-input-changed',
              'output-limit',
              'source-unreadable',
              'slot-not-run',
            ],
          },
          {
            'type': 'null',
          },
        ],
      },
      'retainedOriginalBytes': {
        '$ref': '#/$defs/ArtifactRefList',
      },
      'capture': {
        'anyOf': [
          {
            '$ref': '#/$defs/UncostedCapture',
          },
          {
            'type': 'null',
          },
        ],
      },
    },
  },
  'CaptureInput': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'operation',
      'intentHash',
      'descriptorHash',
      'generationId',
      'reservationRevision',
      'inflightEpoch',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'operation': {
        'const': 'collectFrozenRegisteredSlotsV1',
      },
      'intentHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'descriptorHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'generationId': {
        '$ref': '#/$defs/GenerationId',
      },
      'reservationRevision': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'inflightEpoch': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 9007199254740991,
      },
    },
  },
  'CaptureOutput': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'kind',
      'intentHash',
      'descriptorHash',
      'generationId',
      'reservationRevision',
      'inflightEpoch',
      'orderedSlots',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'kind': {
        'const': 'fixed-trial-uncosted-captures-v1',
      },
      'intentHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'descriptorHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'generationId': {
        '$ref': '#/$defs/GenerationId',
      },
      'reservationRevision': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'inflightEpoch': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 9007199254740991,
      },
      'orderedSlots': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/CaptureSlot',
        },
        'minItems': 2,
        'maxItems': 32,
      },
    },
  },
  'CostSlot': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'sessionId',
      'sessionSnapshotHash',
      'capturedRequestHashes',
      'status',
      'witnessBytes',
      'registrationArtifactHashes',
      'settlementArtifactHashes',
      'reason',
    ],
    'properties': {
      'sessionId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'sessionSnapshotHash': {
        'anyOf': [
          {
            'type': 'string',
            'pattern': '^[a-f0-9]{64}$',
          },
          {
            'type': 'null',
          },
        ],
      },
      'capturedRequestHashes': {
        'type': 'array',
        'items': {
          'type': 'string',
          'pattern': '^[a-f0-9]{64}$',
        },
        'minItems': 0,
        'maxItems': 32,
      },
      'status': {
        'enum': [
          'verified',
          'unknown',
          'unavailable',
        ],
      },
      'witnessBytes': {
        'anyOf': [
          {
            '$ref': '#/$defs/BlobRef',
          },
          {
            'type': 'null',
          },
        ],
      },
      'registrationArtifactHashes': {
        'type': 'array',
        'items': {
          'type': 'string',
          'pattern': '^[a-f0-9]{64}$',
        },
        'minItems': 0,
        'maxItems': 32,
      },
      'settlementArtifactHashes': {
        'type': 'array',
        'items': {
          'type': 'string',
          'pattern': '^[a-f0-9]{64}$',
        },
        'minItems': 0,
        'maxItems': 32,
      },
      'reason': {
        'anyOf': [
          {
            'enum': [
              'incomplete-capture',
              'missing-dispatch',
              'extra-dispatch',
              'pending-attempt',
              'duplicate-attribution',
              'usage-incomplete',
              'identity-mismatch',
            ],
          },
          {
            'type': 'null',
          },
        ],
      },
    },
  },
  'CostResolution': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'kind',
      'intentHash',
      'descriptorHash',
      'generationId',
      'reservationRevision',
      'orderedSlots',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'kind': {
        'const': 'fixed-trial-native-cost-resolution-v1',
      },
      'intentHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'descriptorHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'generationId': {
        '$ref': '#/$defs/GenerationId',
      },
      'reservationRevision': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'orderedSlots': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/CostSlot',
        },
        'minItems': 2,
        'maxItems': 32,
      },
    },
  },
  'AssemblerInput': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'operation',
      'intentHash',
      'descriptorHash',
      'generationId',
      'reservationRevision',
      'inflightEpoch',
      'captureOutputHash',
      'costResolutionHash',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'operation': {
        'const': 'assembleFrozenTrialConfigV1',
      },
      'intentHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'descriptorHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'generationId': {
        '$ref': '#/$defs/GenerationId',
      },
      'reservationRevision': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'inflightEpoch': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 9007199254740991,
      },
      'captureOutputHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'costResolutionHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
    },
  },
  'AssemblerOutput': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'kind',
      'intentHash',
      'descriptorHash',
      'generationId',
      'reservationRevision',
      'inflightEpoch',
      'status',
      'completedConfigBytes',
      'orderedRegisteredManifestHashes',
      'orderedCostWitnessHashes',
      'completedLaunchBytes',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'kind': {
        'const': 'fixed-trial-completed-config-v1',
      },
      'intentHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'descriptorHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'generationId': {
        '$ref': '#/$defs/GenerationId',
      },
      'reservationRevision': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'inflightEpoch': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 9007199254740991,
      },
      'status': {
        'enum': [
          'complete',
          'ineligible-observation',
        ],
      },
      'completedConfigBytes': {
        'anyOf': [
          {
            '$ref': '#/$defs/BlobRef',
          },
          {
            'type': 'null',
          },
        ],
      },
      'orderedRegisteredManifestHashes': {
        'type': 'array',
        'items': {
          'type': 'string',
          'pattern': '^[a-f0-9]{64}$',
        },
        'minItems': 0,
        'maxItems': 32,
      },
      'orderedCostWitnessHashes': {
        'type': 'array',
        'items': {
          'type': 'string',
          'pattern': '^[a-f0-9]{64}$',
        },
        'minItems': 0,
        'maxItems': 32,
      },
      'completedLaunchBytes': {
        'anyOf': [
          {
            '$ref': '#/$defs/BlobRef',
          },
          {
            'type': 'null',
          },
        ],
      },
    },
  },
  'FrozenSlot': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'pairId',
      'role',
      'useId',
      'sessionId',
      'turn',
      'captureOutcome',
      'originalSnapshotHash',
      'captureFactsHash',
      'wholeOutputHash',
      'actualTaskFiles',
      'capturedRequestHashes',
      'costStatus',
      'costWitnessHash',
      'registeredManifestHash',
      'retainedOriginalBytes',
      'taskProjectionHash',
    ],
    'properties': {
      'pairId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'role': {
        'enum': [
          'baseline',
          'candidate',
        ],
      },
      'useId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'sessionId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'turn': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 9007199254740991,
      },
      'captureOutcome': {
        'enum': [
          'complete',
          'incomplete',
          'cancelled',
          'invalid-source',
          'unreadable-source',
          'not-run',
        ],
      },
      'originalSnapshotHash': {
        'anyOf': [
          {
            'type': 'string',
            'pattern': '^[a-f0-9]{64}$',
          },
          {
            'type': 'null',
          },
        ],
      },
      'captureFactsHash': {
        'anyOf': [
          {
            'type': 'string',
            'pattern': '^[a-f0-9]{64}$',
          },
          {
            'type': 'null',
          },
        ],
      },
      'wholeOutputHash': {
        'anyOf': [
          {
            'type': 'string',
            'pattern': '^[a-f0-9]{64}$',
          },
          {
            'type': 'null',
          },
        ],
      },
      'actualTaskFiles': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/FrozenInput',
        },
        'minItems': 0,
        'maxItems': 66,
      },
      'capturedRequestHashes': {
        'type': 'array',
        'items': {
          'type': 'string',
          'pattern': '^[a-f0-9]{64}$',
        },
        'minItems': 0,
        'maxItems': 32,
      },
      'costStatus': {
        'enum': [
          'verified',
          'unknown',
          'unavailable',
        ],
      },
      'costWitnessHash': {
        'anyOf': [
          {
            'type': 'string',
            'pattern': '^[a-f0-9]{64}$',
          },
          {
            'type': 'null',
          },
        ],
      },
      'registeredManifestHash': {
        'anyOf': [
          {
            'type': 'string',
            'pattern': '^[a-f0-9]{64}$',
          },
          {
            'type': 'null',
          },
        ],
      },
      'retainedOriginalBytes': {
        '$ref': '#/$defs/ArtifactRefList',
      },
      'taskProjectionHash': {
        'anyOf': [
          {
            '$ref': '#/$defs/Hash',
          },
          {
            'type': 'null',
          },
        ],
      },
    },
  },
  'FrozenObservations': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'kind',
      'intentHash',
      'descriptorHash',
      'generationId',
      'admissionEpoch',
      'reservationRevision',
      'captureOutputHash',
      'costResolutionHash',
      'completedConfigHash',
      'orderedSlots',
      'status',
      'completedLaunchHash',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'kind': {
        'const': 'fixed-trial-frozen-observations-v1',
      },
      'intentHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'descriptorHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'generationId': {
        '$ref': '#/$defs/GenerationId',
      },
      'admissionEpoch': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 9007199254740991,
      },
      'reservationRevision': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'captureOutputHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'costResolutionHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'completedConfigHash': {
        'anyOf': [
          {
            'type': 'string',
            'pattern': '^[a-f0-9]{64}$',
          },
          {
            'type': 'null',
          },
        ],
      },
      'orderedSlots': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/FrozenSlot',
        },
        'minItems': 2,
        'maxItems': 32,
      },
      'status': {
        'enum': [
          'complete',
          'ineligible-observation',
        ],
      },
      'completedLaunchHash': {
        'anyOf': [
          {
            '$ref': '#/$defs/Hash',
          },
          {
            'type': 'null',
          },
        ],
      },
    },
  },
  'FreezeState': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'generationId',
      'phase',
      'reservationRevision',
      'inflightEpoch',
      'evidenceHash',
      'completedConfigHash',
      'reason',
      'completedLaunchHash',
    ],
    'properties': {
      'generationId': {
        '$ref': '#/$defs/GenerationId',
      },
      'phase': {
        'enum': [
          'reserved',
          'frozen',
          'failed',
        ],
      },
      'reservationRevision': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'inflightEpoch': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 9007199254740991,
      },
      'evidenceHash': {
        'anyOf': [
          {
            'type': 'string',
            'pattern': '^[a-f0-9]{64}$',
          },
          {
            'type': 'null',
          },
        ],
      },
      'completedConfigHash': {
        'anyOf': [
          {
            'type': 'string',
            'pattern': '^[a-f0-9]{64}$',
          },
          {
            'type': 'null',
          },
        ],
      },
      'reason': {
        'anyOf': [
          {
            'enum': [
              'capture-incomplete',
              'cost-unknown',
              'source-invalid',
              'actor-fence-conflict',
              'cancelled',
              'io-failure',
              'revoked',
              'expired',
            ],
          },
          {
            'type': 'null',
          },
        ],
      },
      'completedLaunchHash': {
        'anyOf': [
          {
            '$ref': '#/$defs/Hash',
          },
          {
            'type': 'null',
          },
        ],
      },
    },
  },
  'Reservation': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'requestDigest',
      'operation',
      'phase',
    ],
    'properties': {
      'requestDigest': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'operation': {
        'enum': [
          'sealPromotion',
          'signKnowledgeUseJournal',
          'verifyCandidate',
          'evaluateCapturedUse',
          'finalizeMeasuredTrial',
          'registerProviderDispatch',
          'admitProviderRequest',
          'recordProviderSettlement',
          'resolveSettledUseCost',
        ],
      },
      'phase': {
        'enum': [
          'reserved',
          'spent',
          'revoked',
        ],
      },
    },
  },
  'LiveDescriptorCost': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'admissionHash',
      'ledgerArtifactHash',
      'maximumNewDispatches',
      'maximumNewSettlements',
    ],
    'properties': {
      'admissionHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'ledgerArtifactHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'maximumNewDispatches': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 32,
      },
      'maximumNewSettlements': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 32,
      },
    },
  },
  'DescriptorV1': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'grantHash',
      'preRegistrationHash',
      'proposalHash',
      'candidateHash',
      'sourceBindingHash',
      'projectRoot',
      'profileIdentity',
      'buildIdentity',
      'expiresAt',
      'sessionIDs',
      'fixedOracleIDs',
      'operationLimits',
      'liveCostAdmission',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'grantHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'preRegistrationHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'proposalHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'candidateHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'sourceBindingHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'projectRoot': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 4096,
        'pattern': '^/[^\\u0000]*$',
      },
      'profileIdentity': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'buildIdentity': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'expiresAt': {
        '$ref': '#/$defs/Utc',
      },
      'sessionIDs': {
        'type': 'array',
        'items': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 160,
        },
        'minItems': 2,
        'maxItems': 32,
      },
      'fixedOracleIDs': {
        'type': 'array',
        'items': {
          'enum': [
            'invoice-v1',
            'single-line-v1',
            'pagination-v1',
          ],
        },
        'minItems': 1,
        'maxItems': 3,
      },
      'operationLimits': {
        '$ref': '#/$defs/OperationLimits',
      },
      'liveCostAdmission': {
        '$ref': '#/$defs/LiveDescriptorCost',
      },
    },
  },
  'SlotEpoch': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'sessionId',
      'firstDispatchEpoch',
    ],
    'properties': {
      'sessionId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'firstDispatchEpoch': {
        'anyOf': [
          {
            'type': 'integer',
            'minimum': 1,
            'maximum': 9007199254740991,
          },
          {
            'type': 'null',
          },
        ],
      },
    },
  },
  'TrialStateV2': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'descriptor',
      'phase',
      'reservations',
      'intentHash',
      'registrationEpoch',
      'admissionEpoch',
      'inflightEpoch',
      'orderedSlotEpochs',
      'freeze',
      'collection',
    ],
    'properties': {
      'descriptor': {
        '$ref': '#/$defs/DescriptorV1',
      },
      'phase': {
        'enum': [
          'registered',
          'admitted',
          'revoked',
        ],
      },
      'reservations': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/Reservation',
        },
        'minItems': 0,
        'maxItems': 8192,
      },
      'intentHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'registrationEpoch': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 9007199254740991,
      },
      'admissionEpoch': {
        'anyOf': [
          {
            'type': 'integer',
            'minimum': 1,
            'maximum': 9007199254740991,
          },
          {
            'type': 'null',
          },
        ],
      },
      'inflightEpoch': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'orderedSlotEpochs': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/SlotEpoch',
        },
        'minItems': 2,
        'maxItems': 32,
      },
      'freeze': {
        'anyOf': [
          {
            '$ref': '#/$defs/FreezeState',
          },
          {
            'type': 'null',
          },
        ],
      },
      'collection': {
        '$ref': '#/$defs/Collection',
      },
    },
  },
  'CostRegistration': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'kind',
      'dispatchId',
      'descriptorHash',
      'sessionIdHash',
      'capturedRequestHash',
      'requestBodyHash',
      'maxTokens',
      'model',
      'sourceBindingHash',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'kind': {
        'const': 'registered-provider-dispatch-v1',
      },
      'dispatchId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'descriptorHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'sessionIdHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'capturedRequestHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'requestBodyHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'maxTokens': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 8192,
      },
      'model': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'sourceBindingHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
    },
  },
  'Settlement': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'dispatchId',
      'attemptId',
      'sessionIdHash',
      'requestBodyHash',
      'maxTokens',
      'inputTokens',
      'outputTokens',
      'upperBoundMicroCny',
      'responseIdHash',
      'responseModel',
      'finishReason',
      'settledAt',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'dispatchId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'attemptId': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'sessionIdHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'requestBodyHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'maxTokens': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 8192,
      },
      'inputTokens': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 1048576,
      },
      'outputTokens': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 8192,
      },
      'upperBoundMicroCny': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'responseIdHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'responseModel': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'finishReason': {
        'enum': [
          'stop',
          'length',
          'tool_calls',
        ],
      },
      'settledAt': {
        '$ref': '#/$defs/Utc',
      },
    },
  },
  'CostAttempt': {
    'oneOf': [
      {
        'type': 'object',
        'additionalProperties': false,
        'required': [
          'attemptId',
          'phase',
        ],
        'properties': {
          'attemptId': {
            'type': 'string',
            'minLength': 1,
            'maxLength': 160,
          },
          'phase': {
            'const': 'observed',
          },
        },
      },
      {
        'type': 'object',
        'additionalProperties': false,
        'required': [
          'attemptId',
          'phase',
          'settlement',
          'settlementArtifactHash',
        ],
        'properties': {
          'attemptId': {
            'type': 'string',
            'minLength': 1,
            'maxLength': 160,
          },
          'phase': {
            'const': 'settled',
          },
          'settlement': {
            '$ref': '#/$defs/Settlement',
          },
          'settlementArtifactHash': {
            'type': 'string',
            'pattern': '^[a-f0-9]{64}$',
          },
        },
      },
    ],
  },
  'CostEntry': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'registration',
      'registrationArtifactHash',
      'attempts',
    ],
    'properties': {
      'registration': {
        '$ref': '#/$defs/CostRegistration',
      },
      'registrationArtifactHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'attempts': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/CostAttempt',
        },
        'minItems': 0,
        'maxItems': 32,
      },
    },
  },
  'OwnerStateV2': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'revision',
      'trials',
      'costEntries',
    ],
    'properties': {
      'schemaVersion': {
        'const': 2,
      },
      'revision': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'trials': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/TrialStateV2',
        },
        'minItems': 0,
        'maxItems': 64,
      },
      'costEntries': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/CostEntry',
        },
        'minItems': 0,
        'maxItems': 4096,
      },
    },
  },
  'IntentHelperLaunch': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'kind',
      'intentHash',
      'artifactRoot',
      'sourceBindingHash',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'kind': {
        'const': 'fixed-trial-intent-helper-launch-v1',
      },
      'intentHash': {
        '$ref': '#/$defs/Hash',
      },
      'artifactRoot': {
        '$ref': '#/$defs/AbsolutePath',
      },
      'sourceBindingHash': {
        '$ref': '#/$defs/Hash',
      },
    },
  },
  'DescribeIntentInput': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'operation',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'operation': {
        'const': 'describeAdmissionIntentV1',
      },
    },
  },
  'DescribeIntentOutput': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'kind',
      'intentHash',
      'sourceBindingHash',
      'descriptor',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'kind': {
        'const': 'fixed-trial-admission-description-v1',
      },
      'intentHash': {
        '$ref': '#/$defs/Hash',
      },
      'sourceBindingHash': {
        '$ref': '#/$defs/Hash',
      },
      'descriptor': {
        '$ref': '#/$defs/DescriptorV1',
      },
    },
  },
  'CaptureNextRequest': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'operation',
      'descriptorHash',
      'expectedOwnerRevision',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'operation': {
        'const': 'captureNextCompletedRegisteredSlot',
      },
      'descriptorHash': {
        '$ref': '#/$defs/Hash',
      },
      'expectedOwnerRevision': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
    },
  },
  'FrozenTaskProjection': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'kind',
      'intentHash',
      'descriptorHash',
      'generationId',
      'slotIndex',
      'sessionId',
      'logicalProjectRoot',
      'physicalRelativeRoot',
      'files',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'kind': {
        'const': 'fixed-trial-task-projection-v1',
      },
      'intentHash': {
        '$ref': '#/$defs/Hash',
      },
      'descriptorHash': {
        '$ref': '#/$defs/Hash',
      },
      'generationId': {
        '$ref': '#/$defs/GenerationId',
      },
      'slotIndex': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 31,
      },
      'sessionId': {
        '$ref': '#/$defs/Id',
      },
      'logicalProjectRoot': {
        '$ref': '#/$defs/AbsolutePath',
      },
      'physicalRelativeRoot': {
        '$ref': '#/$defs/RelativePath',
      },
      'files': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/FrozenInput',
        },
        'minItems': 1,
        'maxItems': 66,
      },
    },
  },
  'CaptureNextInput': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'operation',
      'intentHash',
      'descriptorHash',
      'generationId',
      'slotIndex',
      'reservationRevision',
      'inflightEpoch',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'operation': {
        'const': 'captureNextCompletedRegisteredSlotV1',
      },
      'intentHash': {
        '$ref': '#/$defs/Hash',
      },
      'descriptorHash': {
        '$ref': '#/$defs/Hash',
      },
      'generationId': {
        '$ref': '#/$defs/GenerationId',
      },
      'slotIndex': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 31,
      },
      'reservationRevision': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'inflightEpoch': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 9007199254740991,
      },
    },
  },
  'CaptureNextOutput': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'kind',
      'intentHash',
      'descriptorHash',
      'generationId',
      'slotIndex',
      'reservationRevision',
      'inflightEpoch',
      'slot',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'kind': {
        'const': 'fixed-trial-next-slot-capture-v1',
      },
      'intentHash': {
        '$ref': '#/$defs/Hash',
      },
      'descriptorHash': {
        '$ref': '#/$defs/Hash',
      },
      'generationId': {
        '$ref': '#/$defs/GenerationId',
      },
      'slotIndex': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 31,
      },
      'reservationRevision': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'inflightEpoch': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 9007199254740991,
      },
      'slot': {
        '$ref': '#/$defs/CaptureSlot',
      },
    },
  },
  'CaptureNextResponse': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'descriptorHash',
      'generationId',
      'slotIndex',
      'status',
      'ownerRevision',
      'captureArtifactHash',
      'reason',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'descriptorHash': {
        '$ref': '#/$defs/Hash',
      },
      'generationId': {
        'anyOf': [
          {
            '$ref': '#/$defs/GenerationId',
          },
          {
            'type': 'null',
          },
        ],
      },
      'slotIndex': {
        'anyOf': [
          {
            'type': 'integer',
            'minimum': 0,
            'maximum': 31,
          },
          {
            'type': 'null',
          },
        ],
      },
      'status': {
        'enum': [
          'captured',
          'incomplete',
          'rejected',
          'reserved-uncertain',
        ],
      },
      'ownerRevision': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 9007199254740991,
      },
      'captureArtifactHash': {
        'anyOf': [
          {
            '$ref': '#/$defs/Hash',
          },
          {
            'type': 'null',
          },
        ],
      },
      'reason': {
        'anyOf': [
          {
            'enum': [
              'stale-revision',
              'not-admitted',
              'expired',
              'revoked',
              'capture-active',
              'slot-already-captured',
              'all-slots-captured',
              'owned-run-not-joined',
              'capture-incomplete',
              'source-invalid',
              'actor-fence-conflict',
              'cancelled',
              'io-failure',
            ],
          },
          {
            'type': 'null',
          },
        ],
      },
    },
  },
  'CollectedSlot': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'slotIndex',
      'sessionId',
      'captureArtifactHash',
      'captureOutcome',
    ],
    'properties': {
      'slotIndex': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 31,
      },
      'sessionId': {
        '$ref': '#/$defs/Id',
      },
      'captureArtifactHash': {
        '$ref': '#/$defs/Hash',
      },
      'captureOutcome': {
        'enum': [
          'complete',
          'incomplete',
          'cancelled',
          'invalid-source',
          'unreadable-source',
        ],
      },
    },
  },
  'Collection': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'generationId',
      'phase',
      'nextSlotIndex',
      'reservationRevision',
      'inflightEpoch',
      'orderedCaptures',
      'reason',
      'failureEvidenceHash',
    ],
    'properties': {
      'generationId': {
        '$ref': '#/$defs/GenerationId',
      },
      'phase': {
        'enum': [
          'collecting',
          'slot-reserved',
          'collected',
          'failed',
        ],
      },
      'nextSlotIndex': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 32,
      },
      'reservationRevision': {
        'anyOf': [
          {
            'type': 'integer',
            'minimum': 0,
            'maximum': 9007199254740991,
          },
          {
            'type': 'null',
          },
        ],
      },
      'inflightEpoch': {
        'type': 'integer',
        'minimum': 1,
        'maximum': 9007199254740991,
      },
      'orderedCaptures': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/CollectedSlot',
        },
        'minItems': 0,
        'maxItems': 32,
      },
      'reason': {
        'anyOf': [
          {
            'enum': [
              'actor-fence-conflict',
              'cancelled',
              'io-failure',
              'revoked',
              'expired',
            ],
          },
          {
            'type': 'null',
          },
        ],
      },
      'failureEvidenceHash': {
        'anyOf': [
          {
            '$ref': '#/$defs/Hash',
          },
          {
            'type': 'null',
          },
        ],
      },
    },
  },
  'CompletedEvaluationLaunch': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'kind',
      'intentHash',
      'descriptorHash',
      'generationId',
      'artifactRoot',
      'sourceBindingHash',
      'completedConfigHash',
      'orderedTaskProjectionHashes',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'kind': {
        'const': 'fixed-trial-completed-evaluation-launch-v1',
      },
      'intentHash': {
        '$ref': '#/$defs/Hash',
      },
      'descriptorHash': {
        '$ref': '#/$defs/Hash',
      },
      'generationId': {
        '$ref': '#/$defs/GenerationId',
      },
      'artifactRoot': {
        '$ref': '#/$defs/AbsolutePath',
      },
      'sourceBindingHash': {
        '$ref': '#/$defs/Hash',
      },
      'completedConfigHash': {
        '$ref': '#/$defs/Hash',
      },
      'orderedTaskProjectionHashes': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/Hash',
        },
        'minItems': 2,
        'maxItems': 32,
      },
    },
  },
  'ReviewItem': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'descriptor',
      'phase',
    ],
    'properties': {
      'descriptor': {
        '$ref': '#/$defs/LegacyDescriptorV1',
      },
      'phase': {
        'enum': [
          'registered',
          'admitted',
          'revoked',
        ],
      },
    },
  },
  'OwnerReviewSnapshotV2': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'ownerRevision',
      'reviews',
    ],
    'properties': {
      'schemaVersion': {
        'const': 2,
      },
      'ownerRevision': {
        'anyOf': [
          {
            'type': 'integer',
            'minimum': 0,
            'maximum': 9007199254740991,
          },
          {
            'type': 'null',
          },
        ],
      },
      'reviews': {
        'type': 'array',
        'items': {
          '$ref': '#/$defs/ReviewItem',
        },
        'minItems': 0,
        'maxItems': 64,
      },
    },
  },
  'LegacyOperationLimits': {
    'type': 'object',
    'additionalProperties': false,
    'minProperties': 1,
    'properties': {
      'sealPromotion': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 4096,
      },
      'signKnowledgeUseJournal': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 4096,
      },
      'verifyCandidate': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 4096,
      },
      'evaluateCapturedUse': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 4096,
      },
      'finalizeMeasuredTrial': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 4096,
      },
      'registerProviderDispatch': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 4096,
      },
      'admitProviderRequest': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 4096,
      },
      'recordProviderSettlement': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 4096,
      },
      'resolveSettledUseCost': {
        'type': 'integer',
        'minimum': 0,
        'maximum': 4096,
      },
    },
    'required': [],
  },
  'LegacyDescriptorV1': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'schemaVersion',
      'grantHash',
      'preRegistrationHash',
      'proposalHash',
      'candidateHash',
      'sourceBindingHash',
      'projectRoot',
      'profileIdentity',
      'buildIdentity',
      'expiresAt',
      'sessionIDs',
      'fixedOracleIDs',
      'operationLimits',
    ],
    'properties': {
      'schemaVersion': {
        'const': 1,
      },
      'grantHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'preRegistrationHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'proposalHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'candidateHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'sourceBindingHash': {
        'type': 'string',
        'pattern': '^[a-f0-9]{64}$',
      },
      'projectRoot': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 4096,
        'pattern': '^/[^\\u0000]*$',
      },
      'profileIdentity': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 160,
      },
      'buildIdentity': {
        'type': 'string',
        'minLength': 1,
        'maxLength': 512,
      },
      'expiresAt': {
        '$ref': '#/$defs/Utc',
      },
      'sessionIDs': {
        'type': 'array',
        'items': {
          'type': 'string',
          'minLength': 1,
          'maxLength': 256,
        },
        'minItems': 1,
        'maxItems': 256,
      },
      'fixedOracleIDs': {
        'type': 'array',
        'items': {
          'enum': [
            'invoice-v1',
            'single-line-v1',
            'pagination-v1',
          ],
        },
        'minItems': 1,
        'maxItems': 3,
      },
      'operationLimits': {
        '$ref': '#/$defs/LegacyOperationLimits',
      },
      'liveCostAdmission': {
        '$ref': '#/$defs/LiveDescriptorCost',
      },
    },
  },
  'GenerationId': {
    'type': 'string',
    'pattern': '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',
  },
} as const

/** Exact approved private Hash shape. */
export type Hash = string

/** Exact approved private Id shape. */
export type Id = string

/** Exact approved private AbsolutePath shape. */
export type AbsolutePath = string

/** Exact approved private RelativePath shape. */
export type RelativePath = string

/** Exact approved private Utc shape. */
export type Utc = string

/** Exact approved private BlobRef shape. */
export type BlobRef = {
  readonly 'hash': string
  readonly 'byteLength': number
}

/** Exact approved private SourceIdentity shape. */
export type SourceIdentity = {
  readonly 'commit': string
  readonly 'sourceDigest': string
  readonly 'dirty': boolean
  readonly 'dirtyDigest': string
  readonly 'buildDigest': string
}

/** Exact approved private Authority shape. */
export type Authority = {
  readonly 'authorityId': string
  readonly 'publicKeySpkiBase64': string
}

/** Exact approved private Authorities shape. */
export type Authorities = {
  readonly 'promotion': Authority
  readonly 'journal': Authority
  readonly 'evaluator': Authority
  readonly 'costAuthorityId': string
  readonly 'producerId': string
}

/** Exact approved private FrozenInput shape. */
export type FrozenInput = {
  readonly 'path': string
  readonly 'bytes': BlobRef
}

/** Exact approved private SingleLineTask shape. */
export type SingleLineTask = {
  readonly 'kind': 'single-line-v1'
  readonly 'terms': FrozenInput
}

/** Exact approved private InvoiceTask shape. */
export type InvoiceTask = {
  readonly 'kind': 'invoice-v1'
  readonly 'invoices': FrozenInput
  readonly 'rates': FrozenInput
}

/** Exact approved private PaginationTask shape. */
export type PaginationTask = {
  readonly 'kind': 'pagination-v1'
  readonly 'codePath': string
  readonly 'protectedFiles': readonly (FrozenInput)[]
  readonly 'timeoutMs': number
  readonly 'initialCodeBytes': BlobRef
}

/** Exact approved private TaskDefinition shape. */
export type TaskDefinition = SingleLineTask | InvoiceTask | PaginationTask

/** Exact approved private Knowledge shape. */
export type Knowledge = {
  readonly 'id': string
  readonly 'sourceContentBytes': BlobRef
  readonly 'renderedBytes': BlobRef
}

/** Exact approved private StartFence shape. */
export type StartFence = {
  readonly 'encoding': 'jsonl' | 'jsonl-zstd'
  readonly 'originalInitialSnapshotBytes': BlobRef
  readonly 'metadataEnvelopeBytes': BlobRef
  readonly 'eventSequencePrefixBytes': BlobRef
  readonly 'lastEventSeq': number | null
  readonly 'expectedTurn': number
}

/** Exact approved private Slot shape. */
export type Slot = {
  readonly 'pairId': string
  readonly 'role': 'baseline' | 'candidate'
  readonly 'useId': string
  readonly 'sessionId': string
  readonly 'turn': number
  readonly 'snapshotRelativePath': string
  readonly 'startFence': StartFence
  readonly 'grantId': string | null
  readonly 'knowledge': Knowledge | null
  readonly 'registeredVerificationRequestBytes': BlobRef
  readonly 'acceptedRuleHash': string
  readonly 'taskDefinition': TaskDefinition
  readonly 'allocatedTaskProjectionRelativeRoot': RelativePath
}

/** Exact approved private PromotionPolicy shape. */
export type PromotionPolicy = {
  readonly 'promotionRequestHashes': readonly (string)[]
  readonly 'promotionVerificationManifestHashes': readonly (string)[]
}

/** Exact approved private OperationLimits shape. */
export type OperationLimits = {
  readonly 'sealPromotion': number
  readonly 'signKnowledgeUseJournal': number
  readonly 'verifyCandidate': number
  readonly 'evaluateCapturedUse': number
  readonly 'finalizeMeasuredTrial': 1
  readonly 'registerProviderDispatch': number
  readonly 'recordProviderSettlement': number
  readonly 'resolveSettledUseCost': number
}

/** Exact approved private CostIntent shape. */
export type CostIntent = {
  readonly 'initialLedgerBytes': BlobRef
  readonly 'ledgerPath': string
  readonly 'endpoint': string
  readonly 'provider': string
  readonly 'configuredModel': string
  readonly 'wireModel': string
  readonly 'maxTokens': number
  readonly 'maximumNewDispatches': number
  readonly 'maximumNewSettlements': number
  readonly 'guardConfigurationBytes': BlobRef
}

/** Exact approved private Core shape. */
export type Core = {
  readonly 'schemaVersion': 1
  readonly 'kind': 'fixed-trial-admission-core-v1'
  readonly 'mode': 'ephemeral-test-only'
  readonly 'trialId': string
  readonly 'packReceiptBytes': BlobRef
  readonly 'installedManifestBytes': BlobRef
  readonly 'runtimeRoot': string
  readonly 'nodePath': string
  readonly 'nodeHash': string
  readonly 'entryRelativePath': 'protected-helpers/scripts/rust-migration/knowledge-use-evaluator.mjs'
  readonly 'entryHash': string
  readonly 'projectRoot': string
  readonly 'sessionRoot': string
  readonly 'artifactRoot': string
  readonly 'authorities': Authorities
  readonly 'proposalBytes': BlobRef
  readonly 'grantBytes': BlobRef
  readonly 'preRegistrationBytes': BlobRef
  readonly 'measurementDefinitionBytes': BlobRef
  readonly 'sourceIdentity': SourceIdentity
  readonly 'buildIdentity': string
  readonly 'profileIdentity': string
  readonly 'originalTaskUtf8Bytes': BlobRef
  readonly 'originalConfigCanonicalBytes': BlobRef
  readonly 'originalPermissionsCanonicalBytes': BlobRef
  readonly 'goalHash': string
  readonly 'policyHash': string
  readonly 'deadline': Utc
  readonly 'expiresAt': Utc
  readonly 'orderedPairIds': readonly (string)[]
  readonly 'orderedSlots': readonly (Slot)[]
  readonly 'promotionPolicy': PromotionPolicy
  readonly 'operationLimits': OperationLimits
  readonly 'cost': CostIntent
  readonly 'guardEntryRelativePath': 'protected-helpers/scripts/rust-migration/knowledge-cost-guard-launcher.mjs'
  readonly 'guardEntryHash': Hash
}

/** Exact approved private Intent shape. */
export type Intent = {
  readonly 'schemaVersion': 1
  readonly 'kind': 'fixed-trial-admission-intent-v1'
  readonly 'core': Core
  readonly 'sourceBindingHash': string
  readonly 'liveCostAdmissionBytes': BlobRef
}

/** Exact approved private FreezeRequest shape. */
export type FreezeRequest = {
  readonly 'schemaVersion': 1
  readonly 'descriptorHash': string
  readonly 'expectedOwnerRevision': number
  readonly 'operation': 'freezeRegisteredTrial'
}

/** Exact approved private FreezeResponse shape. */
export type FreezeResponse = {
  readonly 'schemaVersion': 1
  readonly 'descriptorHash': string
  readonly 'generationId': GenerationId | null
  readonly 'status': 'frozen' | 'failed' | 'reserved-uncertain' | 'rejected'
  readonly 'ownerRevision': number
  readonly 'evidenceHash': string | null
  readonly 'completedConfigHash': string | null
  readonly 'reason': 'stale-revision' | 'not-admitted' | 'expired' | 'revoked' | 'already-freezing' | 'already-frozen' | 'previous-failure' | 'owned-run-not-joined' | 'capture-incomplete' | 'cost-unknown' | 'source-invalid' | 'actor-fence-conflict' | 'cancelled' | 'io-failure' | null
  readonly 'completedLaunchHash': Hash | null
}

/** Exact approved private ArtifactRefList shape. */
export type ArtifactRefList = readonly (BlobRef)[]

/** Exact approved private UncostedCapture shape. */
export type UncostedCapture = {
  readonly 'originalSnapshot': BlobRef
  readonly 'frozenSnapshotRelativePath': string
  readonly 'originalMetadata': BlobRef
  readonly 'captureFactsBytes': BlobRef
  readonly 'journalArtifactBytes': BlobRef
  readonly 'wholeOutputUtf8Bytes': BlobRef
  readonly 'capturedRequestHashes': readonly (string)[]
  readonly 'capturedArtifactBytes': ArtifactRefList
  readonly 'actualTaskFiles': readonly (FrozenInput)[]
  readonly 'taskProjectionBytes': BlobRef
}

/** Exact approved private CaptureSlot shape. */
export type CaptureSlot = {
  readonly 'pairId': string
  readonly 'role': 'baseline' | 'candidate'
  readonly 'useId': string
  readonly 'sessionId': string
  readonly 'turn': number
  readonly 'outcome': 'complete' | 'incomplete' | 'cancelled' | 'invalid-source' | 'unreadable-source' | 'not-run'
  readonly 'reason': 'turn-not-completed' | 'cancelled' | 'identity-mismatch' | 'permission-mismatch' | 'knowledge-mismatch' | 'prefix-mismatch' | 'snapshot-changed' | 'task-input-changed' | 'output-limit' | 'source-unreadable' | 'slot-not-run' | null
  readonly 'retainedOriginalBytes': ArtifactRefList
  readonly 'capture': UncostedCapture | null
}

/** Exact approved private CaptureInput shape. */
export type CaptureInput = {
  readonly 'schemaVersion': 1
  readonly 'operation': 'collectFrozenRegisteredSlotsV1'
  readonly 'intentHash': string
  readonly 'descriptorHash': string
  readonly 'generationId': GenerationId
  readonly 'reservationRevision': number
  readonly 'inflightEpoch': number
}

/** Exact approved private CaptureOutput shape. */
export type CaptureOutput = {
  readonly 'schemaVersion': 1
  readonly 'kind': 'fixed-trial-uncosted-captures-v1'
  readonly 'intentHash': string
  readonly 'descriptorHash': string
  readonly 'generationId': GenerationId
  readonly 'reservationRevision': number
  readonly 'inflightEpoch': number
  readonly 'orderedSlots': readonly (CaptureSlot)[]
}

/** Exact approved private CostSlot shape. */
export type CostSlot = {
  readonly 'sessionId': string
  readonly 'sessionSnapshotHash': string | null
  readonly 'capturedRequestHashes': readonly (string)[]
  readonly 'status': 'verified' | 'unknown' | 'unavailable'
  readonly 'witnessBytes': BlobRef | null
  readonly 'registrationArtifactHashes': readonly (string)[]
  readonly 'settlementArtifactHashes': readonly (string)[]
  readonly 'reason': 'incomplete-capture' | 'missing-dispatch' | 'extra-dispatch' | 'pending-attempt' | 'duplicate-attribution' | 'usage-incomplete' | 'identity-mismatch' | null
}

/** Exact approved private CostResolution shape. */
export type CostResolution = {
  readonly 'schemaVersion': 1
  readonly 'kind': 'fixed-trial-native-cost-resolution-v1'
  readonly 'intentHash': string
  readonly 'descriptorHash': string
  readonly 'generationId': GenerationId
  readonly 'reservationRevision': number
  readonly 'orderedSlots': readonly (CostSlot)[]
}

/** Exact approved private AssemblerInput shape. */
export type AssemblerInput = {
  readonly 'schemaVersion': 1
  readonly 'operation': 'assembleFrozenTrialConfigV1'
  readonly 'intentHash': string
  readonly 'descriptorHash': string
  readonly 'generationId': GenerationId
  readonly 'reservationRevision': number
  readonly 'inflightEpoch': number
  readonly 'captureOutputHash': string
  readonly 'costResolutionHash': string
}

/** Exact approved private AssemblerOutput shape. */
export type AssemblerOutput = {
  readonly 'schemaVersion': 1
  readonly 'kind': 'fixed-trial-completed-config-v1'
  readonly 'intentHash': string
  readonly 'descriptorHash': string
  readonly 'generationId': GenerationId
  readonly 'reservationRevision': number
  readonly 'inflightEpoch': number
  readonly 'status': 'complete' | 'ineligible-observation'
  readonly 'completedConfigBytes': BlobRef | null
  readonly 'orderedRegisteredManifestHashes': readonly (string)[]
  readonly 'orderedCostWitnessHashes': readonly (string)[]
  readonly 'completedLaunchBytes': BlobRef | null
}

/** Exact approved private FrozenSlot shape. */
export type FrozenSlot = {
  readonly 'pairId': string
  readonly 'role': 'baseline' | 'candidate'
  readonly 'useId': string
  readonly 'sessionId': string
  readonly 'turn': number
  readonly 'captureOutcome': 'complete' | 'incomplete' | 'cancelled' | 'invalid-source' | 'unreadable-source' | 'not-run'
  readonly 'originalSnapshotHash': string | null
  readonly 'captureFactsHash': string | null
  readonly 'wholeOutputHash': string | null
  readonly 'actualTaskFiles': readonly (FrozenInput)[]
  readonly 'capturedRequestHashes': readonly (string)[]
  readonly 'costStatus': 'verified' | 'unknown' | 'unavailable'
  readonly 'costWitnessHash': string | null
  readonly 'registeredManifestHash': string | null
  readonly 'retainedOriginalBytes': ArtifactRefList
  readonly 'taskProjectionHash': Hash | null
}

/** Exact approved private FrozenObservations shape. */
export type FrozenObservations = {
  readonly 'schemaVersion': 1
  readonly 'kind': 'fixed-trial-frozen-observations-v1'
  readonly 'intentHash': string
  readonly 'descriptorHash': string
  readonly 'generationId': GenerationId
  readonly 'admissionEpoch': number
  readonly 'reservationRevision': number
  readonly 'captureOutputHash': string
  readonly 'costResolutionHash': string
  readonly 'completedConfigHash': string | null
  readonly 'orderedSlots': readonly (FrozenSlot)[]
  readonly 'status': 'complete' | 'ineligible-observation'
  readonly 'completedLaunchHash': Hash | null
}

/** Exact approved private FreezeState shape. */
export type FreezeState = {
  readonly 'generationId': GenerationId
  readonly 'phase': 'reserved' | 'frozen' | 'failed'
  readonly 'reservationRevision': number
  readonly 'inflightEpoch': number
  readonly 'evidenceHash': string | null
  readonly 'completedConfigHash': string | null
  readonly 'reason': 'capture-incomplete' | 'cost-unknown' | 'source-invalid' | 'actor-fence-conflict' | 'cancelled' | 'io-failure' | 'revoked' | 'expired' | null
  readonly 'completedLaunchHash': Hash | null
}

/** Exact approved private Reservation shape. */
export type Reservation = {
  readonly 'requestDigest': string
  readonly 'operation': 'sealPromotion' | 'signKnowledgeUseJournal' | 'verifyCandidate' | 'evaluateCapturedUse' | 'finalizeMeasuredTrial' | 'registerProviderDispatch' | 'admitProviderRequest' | 'recordProviderSettlement' | 'resolveSettledUseCost'
  readonly 'phase': 'reserved' | 'spent' | 'revoked'
}

/** Exact approved private LiveDescriptorCost shape. */
export type LiveDescriptorCost = {
  readonly 'admissionHash': string
  readonly 'ledgerArtifactHash': string
  readonly 'maximumNewDispatches': number
  readonly 'maximumNewSettlements': number
}

/** Exact approved private DescriptorV1 shape. */
export type DescriptorV1 = {
  readonly 'schemaVersion': 1
  readonly 'grantHash': string
  readonly 'preRegistrationHash': string
  readonly 'proposalHash': string
  readonly 'candidateHash': string
  readonly 'sourceBindingHash': string
  readonly 'projectRoot': string
  readonly 'profileIdentity': string
  readonly 'buildIdentity': string
  readonly 'expiresAt': Utc
  readonly 'sessionIDs': readonly (string)[]
  readonly 'fixedOracleIDs': readonly ('invoice-v1' | 'single-line-v1' | 'pagination-v1')[]
  readonly 'operationLimits': OperationLimits
  readonly 'liveCostAdmission': LiveDescriptorCost
}

/** Exact approved private SlotEpoch shape. */
export type SlotEpoch = {
  readonly 'sessionId': string
  readonly 'firstDispatchEpoch': number | null
}

/** Exact approved private TrialStateV2 shape. */
export type TrialStateV2 = {
  readonly 'descriptor': DescriptorV1
  readonly 'phase': 'registered' | 'admitted' | 'revoked'
  readonly 'reservations': readonly (Reservation)[]
  readonly 'intentHash': string
  readonly 'registrationEpoch': number
  readonly 'admissionEpoch': number | null
  readonly 'inflightEpoch': number
  readonly 'orderedSlotEpochs': readonly (SlotEpoch)[]
  readonly 'freeze': FreezeState | null
  readonly 'collection': Collection
}

/** Exact approved private CostRegistration shape. */
export type CostRegistration = {
  readonly 'schemaVersion': 1
  readonly 'kind': 'registered-provider-dispatch-v1'
  readonly 'dispatchId': string
  readonly 'descriptorHash': string
  readonly 'sessionIdHash': string
  readonly 'capturedRequestHash': string
  readonly 'requestBodyHash': string
  readonly 'maxTokens': number
  readonly 'model': string
  readonly 'sourceBindingHash': string
}

/** Exact approved private Settlement shape. */
export type Settlement = {
  readonly 'schemaVersion': 1
  readonly 'dispatchId': string
  readonly 'attemptId': string
  readonly 'sessionIdHash': string
  readonly 'requestBodyHash': string
  readonly 'maxTokens': number
  readonly 'inputTokens': number
  readonly 'outputTokens': number
  readonly 'upperBoundMicroCny': number
  readonly 'responseIdHash': string
  readonly 'responseModel': string
  readonly 'finishReason': 'stop' | 'length' | 'tool_calls'
  readonly 'settledAt': Utc
}

/** Exact approved private CostAttempt shape. */
export type CostAttempt = {
  readonly 'attemptId': string
  readonly 'phase': 'observed'
}
  | {
    readonly 'attemptId': string
    readonly 'phase': 'settled'
    readonly 'settlement': Settlement
    readonly 'settlementArtifactHash': string
  }

/** Exact approved private CostEntry shape. */
export type CostEntry = {
  readonly 'registration': CostRegistration
  readonly 'registrationArtifactHash': string
  readonly 'attempts': readonly (CostAttempt)[]
}

/** Exact approved private OwnerStateV2 shape. */
export type OwnerStateV2 = {
  readonly 'schemaVersion': 2
  readonly 'revision': number
  readonly 'trials': readonly (TrialStateV2)[]
  readonly 'costEntries': readonly (CostEntry)[]
}

/** Exact approved private IntentHelperLaunch shape. */
export type IntentHelperLaunch = {
  readonly 'schemaVersion': 1
  readonly 'kind': 'fixed-trial-intent-helper-launch-v1'
  readonly 'intentHash': Hash
  readonly 'artifactRoot': AbsolutePath
  readonly 'sourceBindingHash': Hash
}

/** Exact approved private DescribeIntentInput shape. */
export type DescribeIntentInput = {
  readonly 'schemaVersion': 1
  readonly 'operation': 'describeAdmissionIntentV1'
}

/** Exact approved private DescribeIntentOutput shape. */
export type DescribeIntentOutput = {
  readonly 'schemaVersion': 1
  readonly 'kind': 'fixed-trial-admission-description-v1'
  readonly 'intentHash': Hash
  readonly 'sourceBindingHash': Hash
  readonly 'descriptor': DescriptorV1
}

/** Exact approved private CaptureNextRequest shape. */
export type CaptureNextRequest = {
  readonly 'schemaVersion': 1
  readonly 'operation': 'captureNextCompletedRegisteredSlot'
  readonly 'descriptorHash': Hash
  readonly 'expectedOwnerRevision': number
}

/** Exact approved private FrozenTaskProjection shape. */
export type FrozenTaskProjection = {
  readonly 'schemaVersion': 1
  readonly 'kind': 'fixed-trial-task-projection-v1'
  readonly 'intentHash': Hash
  readonly 'descriptorHash': Hash
  readonly 'generationId': GenerationId
  readonly 'slotIndex': number
  readonly 'sessionId': Id
  readonly 'logicalProjectRoot': AbsolutePath
  readonly 'physicalRelativeRoot': RelativePath
  readonly 'files': readonly (FrozenInput)[]
}

/** Exact approved private CaptureNextInput shape. */
export type CaptureNextInput = {
  readonly 'schemaVersion': 1
  readonly 'operation': 'captureNextCompletedRegisteredSlotV1'
  readonly 'intentHash': Hash
  readonly 'descriptorHash': Hash
  readonly 'generationId': GenerationId
  readonly 'slotIndex': number
  readonly 'reservationRevision': number
  readonly 'inflightEpoch': number
}

/** Exact approved private CaptureNextOutput shape. */
export type CaptureNextOutput = {
  readonly 'schemaVersion': 1
  readonly 'kind': 'fixed-trial-next-slot-capture-v1'
  readonly 'intentHash': Hash
  readonly 'descriptorHash': Hash
  readonly 'generationId': GenerationId
  readonly 'slotIndex': number
  readonly 'reservationRevision': number
  readonly 'inflightEpoch': number
  readonly 'slot': CaptureSlot
}

/** Exact approved private CaptureNextResponse shape. */
export type CaptureNextResponse = {
  readonly 'schemaVersion': 1
  readonly 'descriptorHash': Hash
  readonly 'generationId': GenerationId | null
  readonly 'slotIndex': number | null
  readonly 'status': 'captured' | 'incomplete' | 'rejected' | 'reserved-uncertain'
  readonly 'ownerRevision': number
  readonly 'captureArtifactHash': Hash | null
  readonly 'reason': 'stale-revision' | 'not-admitted' | 'expired' | 'revoked' | 'capture-active' | 'slot-already-captured' | 'all-slots-captured' | 'owned-run-not-joined' | 'capture-incomplete' | 'source-invalid' | 'actor-fence-conflict' | 'cancelled' | 'io-failure' | null
}

/** Exact approved private CollectedSlot shape. */
export type CollectedSlot = {
  readonly 'slotIndex': number
  readonly 'sessionId': Id
  readonly 'captureArtifactHash': Hash
  readonly 'captureOutcome': 'complete' | 'incomplete' | 'cancelled' | 'invalid-source' | 'unreadable-source'
}

/** Exact approved private Collection shape. */
export type Collection = {
  readonly 'generationId': GenerationId
  readonly 'phase': 'collecting' | 'slot-reserved' | 'collected' | 'failed'
  readonly 'nextSlotIndex': number
  readonly 'reservationRevision': number | null
  readonly 'inflightEpoch': number
  readonly 'orderedCaptures': readonly (CollectedSlot)[]
  readonly 'reason': 'actor-fence-conflict' | 'cancelled' | 'io-failure' | 'revoked' | 'expired' | null
  readonly 'failureEvidenceHash': Hash | null
}

/** Exact approved private CompletedEvaluationLaunch shape. */
export type CompletedEvaluationLaunch = {
  readonly 'schemaVersion': 1
  readonly 'kind': 'fixed-trial-completed-evaluation-launch-v1'
  readonly 'intentHash': Hash
  readonly 'descriptorHash': Hash
  readonly 'generationId': GenerationId
  readonly 'artifactRoot': AbsolutePath
  readonly 'sourceBindingHash': Hash
  readonly 'completedConfigHash': Hash
  readonly 'orderedTaskProjectionHashes': readonly (Hash)[]
}

/** Exact approved private ReviewItem shape. */
export type ReviewItem = {
  readonly 'descriptor': LegacyDescriptorV1
  readonly 'phase': 'registered' | 'admitted' | 'revoked'
}

/** Exact approved private OwnerReviewSnapshotV2 shape. */
export type OwnerReviewSnapshotV2 = {
  readonly 'schemaVersion': 2
  readonly 'ownerRevision': number | null
  readonly 'reviews': readonly (ReviewItem)[]
}

/** Exact approved private LegacyOperationLimits shape. */
export type LegacyOperationLimits = {
  readonly 'sealPromotion'?: number
  readonly 'signKnowledgeUseJournal'?: number
  readonly 'verifyCandidate'?: number
  readonly 'evaluateCapturedUse'?: number
  readonly 'finalizeMeasuredTrial'?: number
  readonly 'registerProviderDispatch'?: number
  readonly 'admitProviderRequest'?: number
  readonly 'recordProviderSettlement'?: number
  readonly 'resolveSettledUseCost'?: number
}

/** Exact approved private LegacyDescriptorV1 shape. */
export type LegacyDescriptorV1 = {
  readonly 'schemaVersion': 1
  readonly 'grantHash': string
  readonly 'preRegistrationHash': string
  readonly 'proposalHash': string
  readonly 'candidateHash': string
  readonly 'sourceBindingHash': string
  readonly 'projectRoot': string
  readonly 'profileIdentity': string
  readonly 'buildIdentity': string
  readonly 'expiresAt': Utc
  readonly 'sessionIDs': readonly (string)[]
  readonly 'fixedOracleIDs': readonly ('invoice-v1' | 'single-line-v1' | 'pagination-v1')[]
  readonly 'operationLimits': LegacyOperationLimits
  readonly 'liveCostAdmission'?: LiveDescriptorCost
}

/** Exact approved private GenerationId shape. */
export type GenerationId = string

interface DefinitionTypes {
  Hash: Hash
  Id: Id
  AbsolutePath: AbsolutePath
  RelativePath: RelativePath
  Utc: Utc
  BlobRef: BlobRef
  SourceIdentity: SourceIdentity
  Authority: Authority
  Authorities: Authorities
  FrozenInput: FrozenInput
  SingleLineTask: SingleLineTask
  InvoiceTask: InvoiceTask
  PaginationTask: PaginationTask
  TaskDefinition: TaskDefinition
  Knowledge: Knowledge
  StartFence: StartFence
  Slot: Slot
  PromotionPolicy: PromotionPolicy
  OperationLimits: OperationLimits
  CostIntent: CostIntent
  Core: Core
  Intent: Intent
  FreezeRequest: FreezeRequest
  FreezeResponse: FreezeResponse
  ArtifactRefList: ArtifactRefList
  UncostedCapture: UncostedCapture
  CaptureSlot: CaptureSlot
  CaptureInput: CaptureInput
  CaptureOutput: CaptureOutput
  CostSlot: CostSlot
  CostResolution: CostResolution
  AssemblerInput: AssemblerInput
  AssemblerOutput: AssemblerOutput
  FrozenSlot: FrozenSlot
  FrozenObservations: FrozenObservations
  FreezeState: FreezeState
  Reservation: Reservation
  LiveDescriptorCost: LiveDescriptorCost
  DescriptorV1: DescriptorV1
  SlotEpoch: SlotEpoch
  TrialStateV2: TrialStateV2
  CostRegistration: CostRegistration
  Settlement: Settlement
  CostAttempt: CostAttempt
  CostEntry: CostEntry
  OwnerStateV2: OwnerStateV2
  IntentHelperLaunch: IntentHelperLaunch
  DescribeIntentInput: DescribeIntentInput
  DescribeIntentOutput: DescribeIntentOutput
  CaptureNextRequest: CaptureNextRequest
  FrozenTaskProjection: FrozenTaskProjection
  CaptureNextInput: CaptureNextInput
  CaptureNextOutput: CaptureNextOutput
  CaptureNextResponse: CaptureNextResponse
  CollectedSlot: CollectedSlot
  Collection: Collection
  CompletedEvaluationLaunch: CompletedEvaluationLaunch
  ReviewItem: ReviewItem
  OwnerReviewSnapshotV2: OwnerReviewSnapshotV2
  LegacyOperationLimits: LegacyOperationLimits
  LegacyDescriptorV1: LegacyDescriptorV1
  GenerationId: GenerationId
}

const parsers = new Map<keyof DefinitionTypes, ReturnType<typeof z.fromJSONSchema>>()

/** Parse one approved closed boundary; the maintained schema adapter enforces the frozen required fields and bounds.
 * @param name - Exact approved definition.
 * @param value - Untrusted private JSON value.
 * @returns The validated private DTO.
 */
export function parseObservation<N extends keyof DefinitionTypes>(name: N, value: unknown): DefinitionTypes[N] {
  let parser = parsers.get(name)
  if (parser === undefined) {
    parser = z.fromJSONSchema({ $defs: definitions, $ref: `#/$defs/${name}` } as unknown as Parameters<typeof z.fromJSONSchema>[0])
    parsers.set(name, parser)
  }
  return parser.parse(value) as DefinitionTypes[N]
}
