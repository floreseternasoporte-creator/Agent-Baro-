// ═══════════════════════════════════════════════════════
// authRoutes.js
// GitHub OAuth Device Flow — no requiere redirect URL.
// El usuario obtiene un codigo de 8 digitos, lo ingresa en
// github.com/login/device, y la app detecta la autorizacion
// automaticamente via polling. No necesita client secret.
// ═══════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();

// Inicia el device flow. Devuelve device_code, user_code,
// verification_uri, expires_in, interval.
router.post('/auth/github/device', async (req, res) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return res.status(503).json({
      error: 'GitHub OAuth no esta configurado en el servidor. Agrega GITHUB_CLIENT_ID como variable de entorno.',
    });
  }
  try {
    const resp = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, scope: 'repo read:user' }),
    });
    const data = await resp.json();
    if (data.error) return res.status(400).json({ error: data.error_description || data.error });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Polling: intenta cambiar el device_code por un access_token.
// Devuelve { access_token } en exito, o { error: 'authorization_pending' }
// mientras el usuario aun no ha ingresado el codigo en GitHub.
router.post('/auth/github/poll', async (req, res) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const { deviceCode } = req.body;
  if (!clientId || !deviceCode) return res.status(400).json({ error: 'Faltan parametros.' });
  try {
    const resp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lista los repositorios del usuario autenticado (token en header).
// Devuelve los 100 repos mas recientemente actualizados.
router.get('/auth/github/repos', async (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Sin token de autorizacion.' });
  try {
    const [reposResp, userResp] = await Promise.all([
      fetch('https://api.github.com/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator', {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'DevAgent',
          Accept: 'application/vnd.github+json',
        },
      }),
      fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'DevAgent',
          Accept: 'application/vnd.github+json',
        },
      }),
    ]);
    const repos = await reposResp.json();
    const user = await userResp.json();
    res.json({ repos: Array.isArray(repos) ? repos : [], user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
