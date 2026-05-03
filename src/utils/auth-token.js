export function getBearerToken(request) {
  const header = request.headers.authorization || "";

  if (header.startsWith("Bearer ")) {
    return header.slice(7);
  }
}
