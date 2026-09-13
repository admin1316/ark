/** Current installed Session validation used after vocabulary-aware format restoration. */

import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionFormatArtifact, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'

function assertInstalledHeaderFormat(header: SessionFormatHeader): void {
  if (header.version !== SESSION_FORMAT_VERSION) {
    throw new Error(
      `installed Session format is v${SESSION_FORMAT_VERSION}, got v${header.version}`,
    )
  }
  if (header.isSeeded) {
    throw new Error('installed Session adapter does not support inherited catalog seeds')
  }
}

/**
 * Validate current logical metadata through the installed Session package.
 * @param header - detached current logical header.
 * @returns nothing after successful validation.
 */
export function validateInstalledCurrentSessionHeader(header: SessionFormatHeader): void {
  assertInstalledHeaderFormat(header)
  Session.fromRestore(
    SessionId(header.id),
    [],
    header as unknown as SessionHeader,
  )
}

/**
 * Validate an unseeded artifact through the installed Session package.
 * Foreign versions and catalog inheritance are rejected before restoration.
 * @param artifact - vocabulary-restored current logical artifact.
 * @returns nothing after successful validation.
 */
export function validateInstalledCurrentSessionArtifact(artifact: SessionFormatArtifact): void {
  assertInstalledHeaderFormat(artifact.header)
  const cut = artifact.inheritedEventCount
  if (!Number.isSafeInteger(cut) || cut < 0 || Object.is(cut, -0) || cut > artifact.events.length) {
    throw new Error('catalog inherited event count must be a non-negative safe integer within the event log')
  }
  if (cut !== 0) {
    throw new Error('installed Session adapter does not support a nonzero catalog inherited event count')
  }
  Session.fromRestore(
    SessionId(artifact.header.id),
    artifact.events as SessionEvent[],
    artifact.header as unknown as SessionHeader,
  )
}
