// Signing in to GitHub as a GitHub App, with nothing but Web Crypto, so it runs the same in the Worker and in Node's
// tests.

// The app proves who it is with a token it signs with its key, good for at most ten minutes. It's dated a minute back
// in case this clock runs ahead of GitHub's.
export async function appJwt(appId: string, pem: string, now = Date.now()): Promise<string> {
    const t = Math.floor(now / 1000);
    const part = (o: object) => base64url(new TextEncoder().encode(JSON.stringify(o)));
    const data = part({ alg: 'RS256', typ: 'JWT' }) + '.' + part({ iat: t - 60, exp: t + 540, iss: String(appId) });
    const key = await crypto.subtle.importKey('pkcs8', pkcs8(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
    return data + '.' + base64url(new Uint8Array(signature));
}

// GitHub's key file is PKCS #1 ("BEGIN RSA PRIVATE KEY"), and Web Crypto reads PKCS #8: the same key inside a header
// that names the algorithm. A key pasted into a one-line field loses its line breaks, so only the base64 between the
// markers is read.
function pkcs8(pem: string): Uint8Array<ArrayBuffer> {
    const der = Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----|\\n|\s/g, '')), (c) => c.charCodeAt(0));
    if (!pem.includes('BEGIN RSA PRIVATE KEY')) return der;
    const tlv = (tag: number, bytes: number[]) => [tag, ...derLength(bytes.length), ...bytes];
    const rsaEncryption = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
    return new Uint8Array(tlv(0x30, [0x02, 0x01, 0x00, ...rsaEncryption, ...tlv(0x04, [...der])]));
}

function derLength(n: number): number[] {
    if (n < 0x80) return [n];
    const bytes = [];
    for (; n > 0; n >>= 8) bytes.unshift(n & 0xff);
    return [0x80 | bytes.length, ...bytes];
}

export function base64url(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
