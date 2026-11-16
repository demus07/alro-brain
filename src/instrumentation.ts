import type { Instrumentation } from "next";
import { log } from "@/ops/log";

/**
 * Any error a page, route or server action didn't handle ends up here, as one structured
 * log line. Only the path (without its query), the route and the error are kept: never
 * headers, cookies or what was sent.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  log.error("request.error", {
    // One-time links carry their token in the path: it never goes to the logs.
    path: request.path.split("?")[0].replace(/^\/(invite|reset)\/.+/, "/$1/[token]"),
    method: request.method,
    route: context.routePath,
    kind: context.routeType,
    error,
    digest: typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : undefined,
  });
};
