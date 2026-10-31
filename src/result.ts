export type Result<T, E extends string = string> =
	| { ok: true; value: T }
	| { ok: false; error: E };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <E extends string>(error: E): Result<never, E> => ({ ok: false, error });

export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
