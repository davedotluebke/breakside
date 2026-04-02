/** Shared test constants — importable from specs without triggering config side effects. */

export const FRONTEND_PORT = 3099;
export const BACKEND_PORT = 8100;
export const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
export const TEST_PARAMS = `testMode=true&api=${BACKEND_URL}`;
