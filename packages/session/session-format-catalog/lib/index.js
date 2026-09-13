import { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION, Session, SessionId } from "@deepseek-ai/dsh-session";
import { SessionFormatUnsupportedMigrationError, createSessionFormatCatalog } from "@deepseek-ai/dsh-session-format";
import { releasedV0SessionFormatCodec, releasedV1SessionFormatCodec, sessionFormatV0ToV1 } from "@deepseek-ai/dsh-session-format-v0-to-v1";
import { releasedV2SessionFormatCodec, sessionFormatV1ToV2 } from "@deepseek-ai/dsh-session-format-v1-to-v2";
import { assertReleasedV3Header, releasedV3SessionFormatCodec, restoreReleasedV3Artifact, sessionFormatV2ToV3 } from "@deepseek-ai/dsh-session-format-v2-to-v3";
//#region lib/types/current.js
/** Current installed Session validation used after vocabulary-aware format restoration. */
function assertInstalledHeaderFormat(header) {
	if (header.version !== SESSION_FORMAT_VERSION) throw new Error(`installed Session format is v${SESSION_FORMAT_VERSION}, got v${header.version}`);
	if (header.isSeeded) throw new Error("installed Session adapter does not support inherited catalog seeds");
}
/**
* Validate an unseeded artifact through the installed Session package.
* Foreign versions and catalog inheritance are rejected before restoration.
* @param artifact - vocabulary-restored current logical artifact.
* @returns nothing after successful validation.
*/
function validateInstalledCurrentSessionArtifact(artifact) {
	assertInstalledHeaderFormat(artifact.header);
	const cut = artifact.inheritedEventCount;
	if (!Number.isSafeInteger(cut) || cut < 0 || Object.is(cut, -0) || cut > artifact.events.length) throw new Error("catalog inherited event count must be a non-negative safe integer within the event log");
	if (cut !== 0) throw new Error("installed Session adapter does not support a nonzero catalog inherited event count");
	Session.fromRestore(SessionId(artifact.header.id), artifact.events, artifact.header);
}
//#endregion
//#region lib/types/catalog.js
/**
* Static offline codec and migration assembly; target v3 is not installed Session admission.
* The direct imports make historical readability independent of mounted plugins.
*/
/** Physical codec dispatch and complete adjacent chain, independent of mounted plugins. */
const sessionFormatCatalog = createSessionFormatCatalog({
	currentVersion: 3,
	codecs: [
		releasedV0SessionFormatCodec,
		releasedV1SessionFormatCodec,
		releasedV2SessionFormatCodec,
		releasedV3SessionFormatCodec
	],
	currentEncoder: releasedV3SessionFormatCodec,
	migrations: [
		sessionFormatV0ToV1,
		sessionFormatV1ToV2,
		sessionFormatV2ToV3
	],
	restoreCurrent(artifact) {
		const restored = restoreReleasedV3Artifact(artifact, KNOWN_SESSION_EVENT_TYPES);
		validateInstalledCurrentSessionArtifact(restored);
		return restored;
	},
	restoreTransformedCurrent(artifact) {
		return restoreReleasedV3Artifact(artifact, KNOWN_SESSION_EVENT_TYPES);
	},
	restoreCurrentHeader(header) {
		assertReleasedV3Header(header);
		return header;
	}
});
//#endregion
export { SessionFormatUnsupportedMigrationError, sessionFormatCatalog };
