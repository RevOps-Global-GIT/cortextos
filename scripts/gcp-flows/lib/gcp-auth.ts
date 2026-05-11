export async function getAccessToken(): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  const missing = [
    ['GOOGLE_CLIENT_ID', clientId],
    ['GOOGLE_CLIENT_SECRET', clientSecret],
    ['GOOGLE_REFRESH_TOKEN', refreshToken],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required Google OAuth env var(s): ${missing.join(', ')}`);
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId!,
      client_secret: clientSecret!,
      refresh_token: refreshToken!,
      grant_type: 'refresh_token',
    }),
  });

  const bodyText = await response.text();
  let body: { access_token?: string; error?: string; error_description?: string } = {};

  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = {};
  }

  if (response.status !== 200) {
    const detail = body.error_description || body.error || bodyText || 'empty response body';
    throw new Error(`Google OAuth refresh failed with HTTP ${response.status}: ${detail}`);
  }

  if (!body.access_token) {
    throw new Error(`Google OAuth refresh succeeded but no access_token was returned: ${bodyText}`);
  }

  return body.access_token;
}
