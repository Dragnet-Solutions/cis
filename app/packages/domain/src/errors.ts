/** Base class for domain rule violations — distinct from generic Errors so the
 * API layer can map them to 4xx responses rather than 500s. */
export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A mutation was attempted on an edition whose state forbids it. */
export class EditionStateError extends DomainError {
  constructor(message: string) {
    super(message, 'EDITION_STATE');
  }
}

/** Collection cannot open because a precondition (frozen instruments) is unmet. */
export class InstrumentsNotFrozenError extends DomainError {
  constructor(editionId: string) {
    super(
      `Edition ${editionId} cannot open: its survey instruments are not frozen yet`,
      'INSTRUMENTS_NOT_FROZEN',
    );
  }
}

/** A request reason failed the minimum-length rule. */
export class InvalidReasonError extends DomainError {
  constructor() {
    super('A reason of at least 4 characters is required', 'INVALID_REASON');
  }
}

/** A critical action was not in a state that permits the attempted decision. */
export class CriticalActionStateError extends DomainError {
  constructor(message: string) {
    super(message, 'CRITICAL_ACTION_STATE');
  }
}

export const MIN_REASON_LENGTH = 4;
