import "server-only";

/** Base URL for server-side calls to the API; the browser goes through the /api rewrite instead. */
export function apiUrl(): string {
  return process.env["API_URL"] ?? "http://localhost:4000";
}
