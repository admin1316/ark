import { createSessionFormatChain } from "./chain.js";
import { SessionFormatEventCollector } from "./context.js";
import { SessionFormatError, SessionFormatUnsupportedMigrationError } from "./error.js";
import { inspectSessionFormatVersion, snapshotSessionFormatHeader, sessionFormatVersion, } from "./json.js";
/**
 * Compile a build-static physical codec and adjacent migration catalog.
 * @param options - complete codecs, migrations, current version, and restorer.
 * @returns immutable physical dispatch and migration operations.
 */
export function createSessionFormatCatalog(options) {
    const chain = createSessionFormatChain(options);
    const codecs = new Map();
    for (const codec of options.codecs) {
        const version = sessionFormatVersion(codec.version, 'Session format codec version');
        if (codecs.has(version))
            throw new SessionFormatError(`Session format codec v${version} is duplicated`);
        codecs.set(version, Object.freeze({ ...codec }));
    }
    for (let version = 0; version <= chain.currentVersion; version += 1) {
        if (!codecs.has(version))
            throw new SessionFormatError(`Session format codec v${version} is missing`);
    }
    if (codecs.size !== chain.currentVersion + 1) {
        const invalid = [...codecs.keys()].find(version => version > chain.currentVersion);
        throw new SessionFormatError(`Session format codec v${invalid} is newer than current v${chain.currentVersion}`);
    }
    function readHeader(headerValue) {
        let storedVersion;
        try {
            storedVersion = inspectSessionFormatVersion(headerValue);
        }
        catch (error) {
            return malformed(chain.currentVersion, error);
        }
        if (storedVersion > chain.currentVersion) {
            return Object.freeze({
                status: 'unsupported',
                storedVersion,
                targetVersion: chain.currentVersion,
                reason: `stored Session uses newer format v${storedVersion}; this build writes v${chain.currentVersion}`,
            });
        }
        const codec = codecs.get(storedVersion);
        /* v8 ignore next -- construction proves every supported version has exactly one codec. */
        if (codec === undefined) {
            return Object.freeze({
                status: 'unsupported',
                storedVersion,
                targetVersion: chain.currentVersion,
                reason: `this build has no Session format codec for v${storedVersion}`,
            });
        }
        try {
            const decoded = snapshotSessionFormatHeader(codec.decodeHeader(headerValue), `format v${storedVersion} header`);
            const header = chain.migrateHeader(decoded);
            return Object.freeze({
                status: storedVersion === chain.currentVersion ? 'current' : 'migration-required',
                storedVersion,
                targetVersion: chain.currentVersion,
                header,
            });
        }
        catch (error) {
            if (error instanceof SessionFormatUnsupportedMigrationError) {
                return Object.freeze({
                    status: 'unsupported',
                    storedVersion,
                    targetVersion: chain.currentVersion,
                    reason: error.message,
                });
            }
            return malformed(chain.currentVersion, error, storedVersion);
        }
    }
    function artifactCodec(headerValue) {
        const storedVersion = inspectSessionFormatVersion(headerValue);
        if (storedVersion > chain.currentVersion) {
            throw new SessionFormatUnsupportedMigrationError(`stored Session uses newer format v${storedVersion}; this build writes v${chain.currentVersion}`);
        }
        const codec = codecs.get(storedVersion);
        /* v8 ignore next -- construction proves every supported version has exactly one codec. */
        if (codec === undefined) {
            throw new SessionFormatUnsupportedMigrationError(`this build has no Session format codec for v${storedVersion}`);
        }
        return { storedVersion, codec };
    }
    function encodeCurrentHeader(header, inheritedEventCount) {
        if (inspectSessionFormatVersion(header) !== chain.currentVersion) {
            throw new SessionFormatError(`encodeCurrent requires Session format v${chain.currentVersion}`);
        }
        const encoded = options.currentEncoder.encodeHeader(header, inheritedEventCount);
        if (inspectSessionFormatVersion(encoded) !== chain.currentVersion) {
            throw new SessionFormatError('current Session codec returned a non-current header');
        }
        return encoded;
    }
    function createRestore(headerValue, restoreOptions) {
        const { storedVersion, codec } = artifactCodec(headerValue);
        const decoder = codec.createDecoder(headerValue, restoreOptions.recovery);
        const sourceCut = decoder.headerInheritedEventCount;
        if (storedVersion === chain.currentVersion) {
            return new CurrentSessionFormatRestore(decoder, sourceCut, restoreOptions.validation === 'current' ? options.restoreCurrent : identityArtifact, chain.currentVersion);
        }
        const collector = new SessionFormatEventCollector();
        const migration = chain.createStream(decoder.header, sourceCut, collector);
        return new MigratingSessionFormatRestore(decoder, sourceCut, migration, collector, restoreOptions.validation === 'current'
            ? options.restoreCurrent
            : options.restoreTransformedCurrent, restoreOptions.validation, storedVersion, chain.currentVersion);
    }
    return Object.freeze({
        currentVersion: chain.currentVersion,
        readHeader,
        createRestore,
        encodeCurrentHeader,
        encodeCurrentEvent: options.currentEncoder.encodeEvent.bind(options.currentEncoder),
    });
}
class CurrentSessionFormatRestore {
    decoder;
    sourceInheritedEventCount;
    restoreArtifact;
    currentVersion;
    header;
    collector = new SessionFormatEventCollector();
    constructor(decoder, sourceInheritedEventCount, restoreArtifact, currentVersion) {
        this.decoder = decoder;
        this.sourceInheritedEventCount = sourceInheritedEventCount;
        this.restoreArtifact = restoreArtifact;
        this.currentVersion = currentVersion;
        this.header = decoder.header;
    }
    decodeRow(rowValue) {
        this.decoder.decodeRow(rowValue, this.collector);
    }
    finish() {
        const inheritedEventCount = finishDecoder(this.decoder, this.collector, this.sourceInheritedEventCount);
        return restoreCurrentVersion(this.restoreArtifact({
            header: this.header,
            inheritedEventCount,
            events: this.collector.values,
        }), this.currentVersion);
    }
}
class MigratingSessionFormatRestore {
    decoder;
    sourceInheritedEventCount;
    migration;
    collector;
    restoreArtifact;
    validation;
    sourceVersion;
    currentVersion;
    header;
    constructor(decoder, sourceInheritedEventCount, migration, collector, restoreArtifact, validation, sourceVersion, currentVersion) {
        this.decoder = decoder;
        this.sourceInheritedEventCount = sourceInheritedEventCount;
        this.migration = migration;
        this.collector = collector;
        this.restoreArtifact = restoreArtifact;
        this.validation = validation;
        this.sourceVersion = sourceVersion;
        this.currentVersion = currentVersion;
        this.header = migration.header;
    }
    decodeRow(rowValue) {
        this.decoder.decodeRow(rowValue, this);
    }
    emitEvent(event) {
        this.migration.emitEvent(event);
    }
    emitRun(run) {
        this.migration.emitRun(run);
    }
    finish() {
        finishDecoder(this.decoder, this, this.sourceInheritedEventCount);
        const artifact = {
            header: this.header,
            inheritedEventCount: this.migration.finish(),
            events: this.collector.values,
        };
        let restored;
        try {
            restored = this.restoreArtifact(artifact);
        }
        catch (error) {
            if (this.validation === 'current'
                || error instanceof SessionFormatUnsupportedMigrationError)
                throw error;
            const detail = error instanceof Error ? error.message : String(error);
            throw new SessionFormatUnsupportedMigrationError(`Session migration from v${this.sourceVersion} to v${this.currentVersion} refuses the transformed artifact: ${detail}`, { cause: error });
        }
        return restoreCurrentVersion(restored, this.currentVersion);
    }
}
function finishDecoder(decoder, context, sourceInheritedEventCount) {
    const inheritedEventCount = decoder.finish(context);
    if (sourceInheritedEventCount !== undefined && inheritedEventCount !== sourceInheritedEventCount) {
        throw new SessionFormatError('streaming decoder changed its predeclared inherited cut');
    }
    return inheritedEventCount;
}
function restoreCurrentVersion(artifact, currentVersion) {
    if (artifact.header.version !== currentVersion) {
        throw new SessionFormatError(`current Session restorer returned v${artifact.header.version}; expected v${currentVersion}`);
    }
    return artifact;
}
function identityArtifact(artifact) {
    return artifact;
}
function malformed(targetVersion, error, storedVersion) {
    return Object.freeze({
        status: 'malformed',
        ...(storedVersion === undefined ? {} : { storedVersion }),
        targetVersion,
        reason: error instanceof Error ? error.message : String(error),
    });
}
//# sourceMappingURL=catalog.js.map