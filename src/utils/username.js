export function normalizeUsername(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_");
}

export function validateUsername(value) {
  const username = normalizeUsername(value || "");

  if (username.length < 3 || username.length > 20) {
    const error = new Error("Usernames must be 3-20 characters.");
    error.statusCode = 400;
    throw error;
  }

  if (!/^[a-z0-9_]+$/.test(username)) {
    const error = new Error(
      "Usernames may only contain lowercase letters, numbers, and underscores.",
    );
    error.statusCode = 400;
    throw error;
  }

  return username;
}
