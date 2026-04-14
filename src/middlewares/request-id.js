import crypto from "node:crypto";

export function requestIdMiddleware(request, response, next) {
  request.requestId = crypto.randomUUID();
  response.setHeader("x-request-id", request.requestId);
  next();
}
