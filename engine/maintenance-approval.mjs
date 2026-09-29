// This check supplements normal API authentication; proxy traffic is not local approval.
export function isLocalMaintenanceApproval(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req?.socket?.remoteAddress)) return false;
  const headers = req.headers || {};
  if (Object.keys(headers).some(key => /^(forwarded|x-forwarded-.*|cf-.*)$/i.test(key))) return false;
  try {
    const target = new URL(`http://${headers.host}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) return false;
    if (headers.origin && new URL(headers.origin).host !== target.host) return false;
    return true;
  } catch { return false; }
}
