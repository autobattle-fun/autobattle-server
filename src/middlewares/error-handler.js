import { logger } from "../lib/logger.js";

export function errorHandlerMiddleware(error, request, response, _next) {
  const isPrismaConnectivityError =
    error?.name === "PrismaClientInitializationError" ||
    error?.name === "PrismaClientKnownRequestError";

  const statusCode = isPrismaConnectivityError ? 503 : error.statusCode || 500;

  if (statusCode >= 500) {
    logger.error("Unhandled server error", {
      requestId: request.requestId,
      path: request.originalUrl,
      stack: error.stack,
    });
  }

  const isServiceUnavailable = statusCode === 503;

  response.status(statusCode).json({
    error:
      statusCode >= 500
        ? isServiceUnavailable
          ? "Database service is temporarily unavailable. Please retry in a few seconds."
          : "An unexpected server error occurred."
        : error.message,
    requestId: request.requestId,
  });
}
