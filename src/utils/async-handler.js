export function asyncHandler(fn) {
  return function wrappedHandler(request, response, next) {
    Promise.resolve(fn(request, response, next)).catch(next);
  };
}
