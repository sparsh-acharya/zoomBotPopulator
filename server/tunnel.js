// server/tunnel.js
// Opens an ngrok tunnel from inside the Node process so `npm start` is all you
// need — no separate `ngrok http ...` command. Configured entirely via env:
//   NGROK_DOMAIN    - your reserved domain (e.g. my-app.ngrok-free.dev)
//   NGROK_AUTHTOKEN - your ngrok authtoken (from dashboard.ngrok.com)
// If NGROK_DOMAIN is unset, this is a no-op (run your own tunnel however you like).

/**
 * Start the tunnel pointing at the local server port.
 * @param {number|string} port
 * @returns {Promise<string|null>} the public URL, or null if not started.
 */
export async function startTunnel(port) {
  const domain = process.env.NGROK_DOMAIN;
  if (!domain) return null; // tunnel disabled — nothing to do

  try {
    const mod = await import('@ngrok/ngrok');
    const ngrok = mod.default || mod;
    const authtoken = process.env.NGROK_AUTHTOKEN;
    const listener = await ngrok.forward({
      addr: Number(port),
      domain,
      // Use an explicit token if given; otherwise fall back to NGROK_AUTHTOKEN.
      ...(authtoken ? { authtoken } : { authtoken_from_env: true }),
    });
    return listener.url();
  } catch (err) {
    console.error(`[Tunnel] ngrok failed to start: ${err.message}`);
    console.error('[Tunnel] Continuing without a tunnel - Zoom OAuth callback will not work.');
    return null;
  }
}
