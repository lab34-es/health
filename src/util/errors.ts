/** Every failure the CLI reports deliberately, rather than crashing on. */
export class HealthError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'HealthError';
    this.hint = hint;
  }
}

/** Raised when an integration answers with something we cannot use. */
export class IntegrationError extends HealthError {
  readonly integrationId: string;
  readonly status?: number;

  constructor(integrationId: string, message: string, status?: number, hint?: string) {
    super(message, hint);
    this.name = 'IntegrationError';
    this.integrationId = integrationId;
    this.status = status;
  }
}
