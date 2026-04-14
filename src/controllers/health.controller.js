export function healthController(_request, response) {
  response.json({ ok: true, service: "autobattle-server" });
}
