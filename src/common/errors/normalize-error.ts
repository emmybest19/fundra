import { ZodError } from 'zod';
import {
  AppError,
  BadRequestError,
  ConflictError,
  InternalError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  ValidationError,
} from './app-error.ts';
import { classifyDatabaseError } from './database-error.ts';

/** Shape of the errors Express's body parser raises (it does not export a class). */
function bodyParserErrorType(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('type' in error)) return undefined;
  return typeof error.type === 'string' ? error.type : undefined;
}

/**
 * Converts anything thrown into an AppError. Known failures keep their meaning;
 * everything else becomes a 500 whose original error survives only as `cause` (for logs).
 */
export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ZodError) {
    // Zod messages describe the expected type, not the submitted value, so no input is echoed back.
    return new ValidationError(
      error.issues.map((issue) =>
        issue.path.length > 0
          ? { path: issue.path.map(String).join('.'), message: issue.message }
          : { message: issue.message },
      ),
      { cause: error },
    );
  }

  const parserErrorType = bodyParserErrorType(error);
  if (parserErrorType === 'entity.parse.failed') {
    return new BadRequestError('The request body is not valid JSON.', { cause: error });
  }
  if (parserErrorType === 'entity.too.large') {
    return new PayloadTooLargeError(undefined, { cause: error });
  }

  // Database failures a service didn't translate. Never expose SQL, tables or constraints.
  const failure = classifyDatabaseError(error);
  if (failure?.kind === 'RETRYABLE') {
    // Deadlock, serialization failure, lock timeout or expired transaction: rolled back.
    return new ServiceUnavailableError(undefined, { cause: error, retryAfterSeconds: 1 });
  }
  if (failure?.kind === 'UNIQUE') {
    return new ConflictError('This conflicts with an existing record.', { cause: error });
  }
  // Foreign key, NOT NULL, CHECK, append-only, unbalanced ledger: the app should have
  // prevented it, so it's a bug. A 500 here; the error middleware logs the classification.
  return new InternalError(undefined, { cause: error });
}
