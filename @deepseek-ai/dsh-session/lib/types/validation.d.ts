/**
 * Session event/header validation and freezing: the seed/restore/append
 * boundary vocabulary. All functions are stateless pure validators; the
 * session service imports them from here.
 *
 * @module @deepseek-ai/dsh-session/validation
 */
import { SessionId } from './types.ts';
import type { SessionEvent, SessionHeader } from './types.ts';
/**
 * Validate one session header record against the current format and the
 * expected id, then deep-freeze it.
 * @param id - the session id the header must match.
 * @param input - the header record to validate.
 * @returns the validated, frozen header.
 */
export declare function validateSessionHeader(id: SessionId, input: unknown): SessionHeader;
/**
 * Validate and freeze one exclusively owned persistence header in place.
 * @param id - the session id the header must match.
 * @param input - the exclusively owned header to validate.
 * @returns the validated, frozen header.
 */
export declare function validateRestoredSessionHeader(id: SessionId, input: unknown): SessionHeader;
/**
 * Detach, validate, and freeze the creation metadata published by a session.
 * @param id - the session id of the new header.
 * @param source - the creation metadata, or undefined to mint a fresh header.
 * @returns the validated, frozen header.
 */
export declare function snapshotSessionHeader(id: SessionId, source?: SessionHeader): SessionHeader;
/**
 * Validate an exclusively owned event and deeply freeze its identified message
 * without copying the event. The caller transfers an object graph that no
 * producer retains and that shares no mutable children with another event.
 * Use {@link snapshotSessionEvent} when exclusive ownership is not guaranteed.
 * @param event - exclusively owned event imported across a trusted boundary.
 * @returns the same event object with a validated, deeply frozen message.
 */
export declare function adoptSessionEvent<T extends SessionEvent>(event: T): T;
/**
 * Detach one event while preserving deep immutability for its identified message.
 * @param event - event imported across a query or persistence boundary.
 * @returns a detached event snapshot with a validated, deeply frozen message.
 */
export declare function snapshotSessionEvent<T extends SessionEvent>(event: T): T;
/**
 * Deep-freeze one acyclic JSON tree without consuming the JavaScript call stack.
 * @param value - the tree root to freeze in place.
 * @returns the same frozen root.
 */
export declare function freezeRestoredObject<T extends object>(value: T): T;
/**
 * Validate the fixed event envelope after one-pass JSON materialization.
 * @param value - the materialized event record to assert on.
 * @param index - the seed index used in rejection messages.
 * @returns asserts the record is a well-formed session event.
 */
export declare function assertSessionEventEnvelope(value: Record<string, unknown>, index: number): asserts value is SessionEvent;
/**
 * Reject obsolete request headers and malformed messages at the seed/load boundary.
 * @param event - the event record to validate.
 * @param index - the seed index used in rejection messages.
 */
export declare function assertCurrentLlmShape(event: Record<string, unknown>, index: number): void;
/**
 * Validate adapter-default markers imported from a durable request header.
 * @param value - the adapterDefaults record, or undefined to skip.
 * @param config - the request header config the markers reference.
 * @param index - the seed index used in rejection messages.
 */
export declare function assertAdapterDefaults(value: unknown, config: Record<string, unknown>, index: number): void;
/**
 * Validate only the event-specific invariants needed to safely replay a message.
 * @param event - the event record to validate.
 * @param subject - human-readable event label used in rejection messages.
 */
export declare function assertMessageEventShape(event: Record<string, unknown>, subject: string): void;
/**
 * Whether an unknown value carries the current provider/model pair.
 * @param value - the value to inspect.
 * @returns true when both provider and model are non-empty strings.
 */
export declare function hasProviderModel(value: unknown): boolean;
/**
 * Reject request-header vocabulary removed with the legacy delta codec.
 * @param type - the header type to check.
 * @param data - the header data to check for legacy markers.
 * @param location - human-readable location used in rejection messages.
 */
export declare function assertSupportedRequestHeader(type: string, data: unknown, location: string): void;
//# sourceMappingURL=validation.d.ts.map