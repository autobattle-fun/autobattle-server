export async function meController(request, response) {
  if (!request.auth?.user) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  return response.json({ user: request.auth.user });
}
