export async function vercelFetch(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
  const token = process.env.VERCEL_TOKEN;

  if (!token) {
    throw new Error('Missing required Vercel env var: VERCEL_TOKEN');
  }

  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `https://api.vercel.com${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);

  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return fetch(url, { ...init, headers });
}
