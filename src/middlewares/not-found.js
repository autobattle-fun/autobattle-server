export function notFoundMiddleware(request, response) {
  response.status(404).json({
    error: `Route ${request.method} ${request.originalUrl} not found`,
  });
}
