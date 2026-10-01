import type { AppError } from '../errors/index.ts';
import type { ApiErrorBody, ApiSuccess, ApiSuccessWithMeta } from '../types/api.ts';

const GENERIC_SERVER_ERROR = 'An unexpected error occurred.';

export function success<T>(data: T): ApiSuccess<T>;
export function success<T, M>(data: T, meta: M): ApiSuccessWithMeta<T, M>;
export function success(
  data: unknown,
  meta?: unknown,
): ApiSuccess<unknown> | ApiSuccessWithMeta<unknown, unknown> {
  return meta === undefined ? { data } : { data, meta };
}

/** Builds the error body. 5xx errors are reduced to a generic message with no details. */
export function errorBody(error: AppError, requestId?: string): ApiErrorBody {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.expose ? error.message : GENERIC_SERVER_ERROR,
    },
  };
  if (error.expose && error.details !== undefined) body.error.details = error.details;
  if (requestId !== undefined) body.error.requestId = requestId;
  return body;
}
