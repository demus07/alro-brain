/**
 * Hosts on the server's own network. Addresses that members type in (a self-hosted
 * GitLab, a mail server, a live-tool server) are fetched from ALRO's server, so in
 * production they must not point back inside it.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.includes(":") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host)
  );
}

export const mustBePublic = () => process.env.NODE_ENV === "production";
