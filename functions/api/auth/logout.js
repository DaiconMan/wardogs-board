import { clearSessionCookie } from "../../_lib/session.js";
import { json } from "../../_lib/validate.js";
import { requireOrigin } from "../../_lib/guard.js";

export async function onRequestPost({ request }) {
  const bad = requireOrigin(request);
  if (bad) return bad;
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}
