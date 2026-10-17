export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch (err) {
      // Malformed percent-encoding (e.g. another localhost app's cookie) means no usable session, not a server error.
      if (err instanceof URIError) return undefined;
      throw err;
    }
  }
  return undefined;
}
