// Validates body/query/params against Zod schemas and hands typed input to the handler.
import type { Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import { ValidationError, type ErrorDetail } from '../common/errors/index.ts';

type Location = 'params' | 'query' | 'body';

export type RequestSchemas = Partial<Record<Location, z.ZodType>>;

type Parsed<S extends RequestSchemas, K extends Location> = S[K] extends z.ZodType
  ? z.output<S[K]>
  : undefined;

/** What the handler receives: parsed (and transformed) values, or `undefined` if unchecked. */
export interface ValidatedInput<S extends RequestSchemas> {
  params: Parsed<S, 'params'>;
  query: Parsed<S, 'query'>;
  body: Parsed<S, 'body'>;
}

const LOCATIONS: readonly Location[] = ['params', 'query', 'body'];

/**
 * Wraps a route handler so it only runs with valid input, typed from the schemas.
 *
 * Express 5 makes `req.query` read-only, so parsed values are passed to the handler rather
 * than written back onto `req`. Problems in every location are reported together in one
 * 422 (`body.amount`, `query.limit`, ...), so clients can fix everything in one round trip.
 * Submitted values are never echoed back.
 */
export function validated<S extends RequestSchemas>(
  schemas: S,
  handler: (input: ValidatedInput<S>, req: Request, res: Response) => unknown,
): RequestHandler {
  return async (req, res) => {
    const input: Record<Location, unknown> = {
      params: undefined,
      query: undefined,
      body: undefined,
    };
    const details: ErrorDetail[] = [];

    for (const location of LOCATIONS) {
      const schema = schemas[location];
      if (schema === undefined) continue;
      const result = await schema.safeParseAsync(req[location]);
      if (result.success) {
        input[location] = result.data;
      } else {
        for (const issue of result.error.issues) {
          details.push({
            path: [location, ...issue.path.map(String)].join('.'),
            message: issue.message,
          });
        }
      }
    }

    if (details.length > 0) throw new ValidationError(details);
    await handler(input as unknown as ValidatedInput<S>, req, res);
  };
}
