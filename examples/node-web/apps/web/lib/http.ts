/** Error text from a failed API response, tolerating bodies that are not JSON (e.g. a proxy error page). */
export async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : `${fallback} (${res.status})`;
  } catch {
    return `${fallback} (${res.status})`;
  }
}

export const NETWORK_ERROR = "The shop is unavailable right now. Try again in a moment.";
