export const EXIT_OK = 0;
export const EXIT_CHECK_FAILED = 1;
export const EXIT_CONFIG_ERROR = 2;
export const EXIT_ENDPOINT_UNREACHABLE = 3;

export class EvalcheckError extends Error {
  readonly exitCode: number;
  readonly details: string[];

  constructor(message: string, exitCode = EXIT_CONFIG_ERROR, details: string[] = []) {
    super(message);
    this.name = 'EvalcheckError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

export interface ConfigIssue {
  /** Dotted path inside the suite, e.g. `target.url`. */
  path: string;
  message: string;
  /** `file:line:col` when the location could be determined. */
  location?: string;
}

/** Raised for malformed suites, invalid CLI usage and other config problems. */
export class ConfigError extends EvalcheckError {
  readonly issues: ConfigIssue[];

  constructor(message: string, issues: ConfigIssue[] = []) {
    super(message, EXIT_CONFIG_ERROR, issues.map((i) => formatIssue(i)));
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Raised when the target endpoint cannot be reached at all. */
export class EndpointError extends EvalcheckError {
  constructor(message: string, details: string[] = []) {
    super(message, EXIT_ENDPOINT_UNREACHABLE, details);
    this.name = 'EndpointError';
  }
}

/** Raised when a grader cannot produce a verdict (e.g. model missing). */
export class GraderError extends EvalcheckError {
  constructor(message: string, details: string[] = []) {
    super(message, EXIT_CHECK_FAILED, details);
    this.name = 'GraderError';
  }
}

function formatIssue(issue: ConfigIssue): string {
  const loc = issue.location ? ` (${issue.location})` : '';
  return `${issue.path || '<root>'}: ${issue.message}${loc}`;
}

export function isEndpointError(err: unknown): err is EndpointError {
  return err instanceof EndpointError;
}

export function isConfigError(err: unknown): err is ConfigError {
  return err instanceof ConfigError;
}
