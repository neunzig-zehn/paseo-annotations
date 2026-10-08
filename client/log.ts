// The client typechecks without DOM or Node types; every runtime has a console.
declare const console: { error(...details: unknown[]): void };

/** Reports a failure in the app's console, where client plugin logs go. */
export function logError(message: string, error: unknown): void {
  console.error(`[annotations] ${message}`, error);
}
