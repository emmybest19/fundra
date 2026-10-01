import type { ErrorCode, ErrorDetail } from '../errors/index.ts';

/** Successful response: `{ data }`, or `{ data, meta }` for lists and other annotated results. */
export interface ApiSuccess<T> {
  data: T;
}

export interface ApiSuccessWithMeta<T, M> {
  data: T;
  meta: M;
}

/** Error response. `details` lists field-level problems; `requestId` correlates with server logs. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: readonly ErrorDetail[];
    requestId?: string;
  };
}
