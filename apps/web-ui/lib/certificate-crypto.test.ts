import { describe, it, expect } from 'vitest';
import { X509Certificate } from 'crypto';
import {
    computeFingerprint, extractCertDomains, parseCertificate, validateKeyPair, certificateCoversDomain,
} from './certificate-crypto';

// Real, self-signed test material — not secrets. Generated once with:
//   openssl req -x509 -newkey rsa:2048 -keyout key1.pem -out cert1.pem -days 3650 -nodes \
//     -subj "/O=Nucleus Test CA/CN=example.com" \
//     -addext "subjectAltName=DNS:example.com,DNS:*.example.com"
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDaDCCAlCgAwIBAgIUOqG4dSdhQxpSMtO68FbDXr+emJowDQYJKoZIhvcNAQEL
BQAwMDEYMBYGA1UECgwPTnVjbGV1cyBUZXN0IENBMRQwEgYDVQQDDAtleGFtcGxl
LmNvbTAeFw0yNjA4MjYwNTAzNTVaFw0zNjA4MjMwNTAzNTVaMDAxGDAWBgNVBAoM
D051Y2xldXMgVGVzdCBDQTEUMBIGA1UEAwwLZXhhbXBsZS5jb20wggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDI4gA66h35bG6219CaSCNBOQMGdKJ0EBMA
U3Kp4C8YwyhSw6sGFHK3Gnoa+z8OST/MKrHc9WAJOZnrEogNP4BzXlW1+xCx+a6h
uZrw/RHSW0jrMPmb44IWlycxuT1XyMZEz1Yz8/3QOyrTA2rPILM+d0PzGhidhFYc
GvdFSBEhBM8EfUwq8AJhPul5Z4GQmNL8gxuEpOnbAblkdgIEBVmJSCl9WTkAa+Is
MeFZJGUeDmQYvU5fAvBllSDxsZdq4xD0DtDnOUTIiQCkirJOhNPOUKAos8KYZwCa
4taPmpc45iIjt0LUYteQfkq7KspxwsS5Gdarpez5KkVzmgt00J4NAgMBAAGjejB4
MB0GA1UdDgQWBBQaatVXvRlvzxc6oVpB/yEuvNKXQzAfBgNVHSMEGDAWgBQaatVX
vRlvzxc6oVpB/yEuvNKXQzAPBgNVHRMBAf8EBTADAQH/MCUGA1UdEQQeMByCC2V4
YW1wbGUuY29tgg0qLmV4YW1wbGUuY29tMA0GCSqGSIb3DQEBCwUAA4IBAQCZ6xYT
hQQ9DU/NGpItnVp9rj9t5g0y13sUsIu8Zgs+kwNIUAZEXVeXTcE+4JUTReqA0tyw
RgpHDn0lEzpiVbQ9E3mqcuDYmpyZTENbYbuKHCN7a0lyhCSlzUVKWeiTlk+gOhWM
9GbNzcBz8eYVavzcmjWOpVK1punUzsRMUMGegNSAXZnHFQdk0qSLOhn6bOtIYVyO
VXUTWPkfX59n/ULYZreTQTsghadsXhVRXI/8dqmip90P27paXCh0ym068152L9gO
U2Y6azPVcXnq2NM5kF4+a2b2lXrB6dRla+hvisC98zucBTvUFlP43KeU4psidFGS
MNXDOP7iHYhjuPeU
-----END CERTIFICATE-----
`;

const MATCHING_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDI4gA66h35bG62
19CaSCNBOQMGdKJ0EBMAU3Kp4C8YwyhSw6sGFHK3Gnoa+z8OST/MKrHc9WAJOZnr
EogNP4BzXlW1+xCx+a6huZrw/RHSW0jrMPmb44IWlycxuT1XyMZEz1Yz8/3QOyrT
A2rPILM+d0PzGhidhFYcGvdFSBEhBM8EfUwq8AJhPul5Z4GQmNL8gxuEpOnbAblk
dgIEBVmJSCl9WTkAa+IsMeFZJGUeDmQYvU5fAvBllSDxsZdq4xD0DtDnOUTIiQCk
irJOhNPOUKAos8KYZwCa4taPmpc45iIjt0LUYteQfkq7KspxwsS5Gdarpez5KkVz
mgt00J4NAgMBAAECggEAHJm2vCyYe2pRggVMjSa/pDncgScKeRlPx0BaRy7krbMd
ctkqaJlxMroZj+1dDyjlJSmf/KxP0chqbmJLTg2QOXzBGcGG4TwB/cMZ+P0i9C7s
fRXSN/xmiVZYbXco8W5jsijN5mQy6xp9cKEgLCDE/FwJJ9u7jPOqOeKp+Wp3C9rt
K7Ac7p3U2m6fwN9X5numYC92GMytKGxhVvRNKMLkOBBZarvbePm0KqvU4idBkAnT
RypGmk16iWCSQ4OUITRowgxr9lZUYOOtbRNikd6oFPZzF3X//Qd0DnPYT6HBsxZE
F+8pOrvDamduDvRSY6AsSaD/wanFoNe9oQuZZcExUQKBgQD+EJb/WiluqQsCCPkL
KYpBVQca/okCzkd8ZgY3GxzhxYZ0KX8zGdgVwhcs/80Ea10RHcaGz8hHvGdut03D
ioOZs1vJeHi5AQX3CQeJ8QneNyBOxPBclin6IOmjBbL1heWeTO+kEtnFutNC7qKm
koWycDKcIRFv4nBUy+r7kHwjPQKBgQDKabWnBrU8+s/ABviYm0Q87BKJWsXe6YMa
3Gl3KMAqJiQRRw8Sc1HtXmVe2fjR5f6YpdsDfdwcgdUDBLVkNBfiyjmcKC9nHJxG
6drI6GImyYbBCytcww+0jDwjaemSDRpzcLzY0hfl8+gvzBUXQnr2gtcugZEETgVJ
kxt4hhPTEQKBgDQ/6S3etwKhFTh36+/VvS8uc2Wjzz2aeq0ktkaC9u+flcUx+4zg
1cWzwtxoRxuPkPZCL1/uP3wxTPxCCmYaiHIFpuzKL9msUjO50akWvzbKE4Tfj6ca
4sskFaiHNYS04sIphGcz0UGO6H+tYBntrD1EQcRGMLXX1c46mbrevgjpAoGAKNuv
xFhxSy7hssR1d/CXlKiekUVWfcmrIkftrhT2vUtXqnkqjLHkjsKoOb5MIKqJeuy3
yfuk68g1ZFeV+fUeATSK7n+aGflHfnUEKdvmvCef4OXNSftB91L7bLabZFTqyvSt
2iKGmm9ipgtPEpPj2FDO+N9Ek5bgMFrWh7yg0dECgYAGMsPI2MbGleF/+8osdRLW
bYxBvMi1CD5ij5mn1i8GdekTUVOgDDlOmvPsz1lzZCDiXVFkXCpm7zCkBDCvbC0e
kc3sKgXH8dqSElBYeUIiiIlunN2e7dIMEDBgLhOvI1MMTaJ1mp41PtO9y3KpUdAH
KeKmgyGz9p8AUSyUm/EhAw==
-----END PRIVATE KEY-----
`;

// A second, unrelated RSA key — does not correspond to CERT_PEM.
const MISMATCHED_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDQ2kHZO/kW/WL7
FtC+4PrFzu0wCMyM1kfjJ90XdqTCRuyPBOp+aM9balrtS4Dq3erepgX4RgXKrTjI
B+27/t5H0lKCWwfkolRmV6KYuLEuO/ikz5lTGSJ3uBqWQHkAh3gz501p2ls6U18i
mO0BaVAqpJ4ZDBUWEhy/X4o4l/fqhXDt2i5YKrGCMObhnK7nA7v9pihSIC8FILPg
lf6ekEa9EgWvd1o/sx+eiUVGDCNUGYFTirNyucOQ9aq88KA573/fP+QXl6jmgFKl
IbPzmlphFN5jihbEL12fjQ5cGkMpyYAGI7CyIrY1qkqtd93E13n7R+B/a4OfYRSF
Rqcd86KHAgMBAAECggEADjW7YzdkZD8LPAA6ZbJS/aBtnOYMXMy7iWYN8em9ngZL
VBPGjKE+8n5S/3Ayrkg5EbsEDvdcr4SHp3x6nV7i6soRmRLuf4zX5zqxMmjmjTnB
Wh1R1kiQgsrA7FYopXOSJx3ms3wK1vYTM/xpq73pmW0n4JZk3OKQmCi888rLMGaS
XSTYVrSGmUBX7DLsDv+PphJeBZBeX7fYNv12UfDssbjqR7Hzcb4HmSswN+waCHul
Xbrbx+UREOamtRGx+yCAs0wRG/eae+71oQ3OIEjSCJhFFzYEZGwhMASrMTeGn664
Qk6luKBYJlpP7zf0r18sj18oTLo4UCHVwJmrzC4sKQKBgQDzxfKDMgvZ1YZ8LVyn
cSDveXS5FPdsQTurgEdD+U4aWszU3VEOeqf+Uru7b3vQy1B6DyOUE5QoItjfOIW/
jdFUFsFhIGlu2vlEUmdLdMjxqlf1+Sk5I+IuaXVAXrxK37oNWT6Ax5GWRumSLD2d
xAi2DlS35XTo0dkfv7LJE7W0HQKBgQDbU+2N5QXogkyJyk4jQKEjzbynODMKhnOI
eMiYzoYOJeUyn3+8X0hBF0h+HqeiXF3oA3T8ps5JKR6Y5Vz7JkNE4jplzF4jy7em
zwAJ4BOznNPkBk2ZG8PDNfyFmYs4O/mFGmKhdiGzcP56waZrcfmKiij49MJbg7+J
nbWaTWpn8wKBgQDdtVnEUr8OhrICvGr5at2Oj8NGFbiWP5oad9fZDaQoOg7zRrpS
1eF2YB6X8WQF2PQ/nwc3xLrJ6i+ejVSvjDcnKG8GfCkIBqYQqnWB3hxoFwpbDxqb
+nPazFU0jzTnUCVxwIolK9zQdXw3Un9TvphBpDUO7+TtXvX/dyUO1hs7TQKBgQCm
a8iVInKZOkVZSGiB10huIm5DdCFGmz6PDxcm245creR7xQrnpGTu/vvCtv/78ppO
slDSZL+iQ9EzstYau63PVtl45NmJz8pKiEc/Nwe8AgPFwgKfarHgLdauiRNaWCe9
F4g/e6OWxOZTvxzH6nOu66arQQ04438yrLhfnN5ggQKBgFXczeSuCDZxtcyk9Pi2
rA4WHnEOSEFpeABE/Hv+ad41g1rAKJJ2FQSQYKtlhgo0PT9DB7eNIsnrk0eHoiTh
BbwxP8+NscGq5hvJfqgBI3YuLBxy5l0uNEw+EQrhnvdj9AXNjEqMwZLQv3iwVL4M
0EtucVIFHg4zB8DgnLLNso/h
-----END PRIVATE KEY-----
`;

// Subject O= only (no CN), SAN with a non-DNS IP entry only.
const CERT_NO_CN_IP_SAN_PEM = `-----BEGIN CERTIFICATE-----
MIIDKjCCAhKgAwIBAgIUCCxeGiIaB+yhcC7Qkr/ZP8bgzoowDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UECgwRTnVjbGV1cyBCYXJlIENlcnQwHhcNMjYwODI2MDUwNjI1
WhcNMzYwODIzMDUwNjI1WjAcMRowGAYDVQQKDBFOdWNsZXVzIEJhcmUgQ2VydDCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKCyX1IvxLcOwJlbatzOKNTs
hLNfGSwU6qBdiovnOMloCQjJhCAGZQkOrpRG5KbmyZSmIuSBYUgLvABVz+RI1W2+
NXsyFFxqJSW7NsnvabK2sCpcicwBavCnWP1kDKENVOLrl949W27sITqJWSF/FZKA
fDznGhCl7qBZeNTtd3bwH/AAg4HsxiMkXEBSdkCBeW5zTy3q7fvnnlKwCPXe3iIh
RVMjHlTCE4yJ4VRZhe8Gu8ljPyfpIYsywEcHPlLEdh80Q3uS92eq55YKoK+QVuQY
fuf9VgIjEpAatS5PoTdOMqkxLBQmzjCQbGA/lZebAM8nnpPHu91UqKZffR04M+MC
AwEAAaNkMGIwHQYDVR0OBBYEFEe6jA6k6V89j7y9rZWc96d4L7yUMB8GA1UdIwQY
MBaAFEe6jA6k6V89j7y9rZWc96d4L7yUMA8GA1UdEwEB/wQFMAMBAf8wDwYDVR0R
BAgwBocEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAkpOHSiiZdudue0W2HKVVUAEE
mdytY5zeqboT0RSYDUk8Xs8tCWTd+x3LejsBYjEVL/STOfTtSzfo9Ho9rwalAdO6
WXEXXJ+5muIY++FsjjipfLWWk1MDL7/f3t/21u+F4oaigJJBQ3NWoaio/Y4kdtlk
VdSq7Kg4oX3GCMRw2jGGEaojArUi2SmPbk0+EtfRb9/jRVVCgKuuHceI6Vr0d4U+
kxafYFGCaEVRab53pE5OuYrDcVULDhX/uU9oxTr+QF5NN2Pb5qW/EVhZLDznLBi2
dTJC1ZkONwNgTr/IHr2TXN/zIfUUCAkTl0Y8BKv48VGjq254U2ke/Z7zxc5LLA==
-----END CERTIFICATE-----
`;

// Subject O= only (no CN), no SubjectAltName extension at all.
const CERT_NO_CN_NO_SAN_PEM = `-----BEGIN CERTIFICATE-----
MIIDHTCCAgWgAwIBAgIUYlJtG8nctxSZFW5LqsM1JKTLcqQwDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UECgwTTnVjbGV1cyBObyBTQU4gQ2VydDAeFw0yNjA4MjYwNTA2
NDFaFw0zNjA4MjMwNTA2NDFaMB4xHDAaBgNVBAoME051Y2xldXMgTm8gU0FOIENl
cnQwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDivQVoF7KVph9UNFfX
1dXXmciJdybi/eA1BIemI4rksZlei/mMGf/BkSYMzfPEVLsKkezzZdSM8nw2ka0o
AGVCVquPLwtXs/zaUrNpV//mEmc5qbVoIOCj/BOUKCQr2Tue9idQAIvVZhJWRxW5
1DK4RLtELcdK/fwMk4CZ9joZ2mggPk9h7YGFRIpsEU5sUcj97q5maMX/FMbwi3q2
Od32r7Hd94ESN9H+1Lcy8RdeLFE79VTtjUWN37D9RLXrW1cLSKX+lQjkCQGI9Zmu
f+3xHhH7vHLaM5wS2H2qffGUTO75BqdKK4z7oQhECDcU0XV3sjZPy3M2zgE29hgc
KRi3AgMBAAGjUzBRMB0GA1UdDgQWBBTZR+4kQg0rweHh9xTLxIGM05d01jAfBgNV
HSMEGDAWgBTZR+4kQg0rweHh9xTLxIGM05d01jAPBgNVHRMBAf8EBTADAQH/MA0G
CSqGSIb3DQEBCwUAA4IBAQCG1V8YLPxRWck965WMsLqjgn3BffwjPbk9j8xZhLDF
Fykm4vn0NunxS26k8YYNN+LUrVYJ8U0stqum+gjkrTakvj/e6E0V66Y9RiRxjMUV
I8v1Ju+vCYkgQTm/JVmn3sfsBqdQlbayDSy6YYsOc9Ra0dWZD/SHnIL2yk1DRk37
9zzK6ArfzXNGqnjRXf9IQ89qmEBIY1y1uzZ9zeJ4tEowaGHW/H4y62P7V4Xx9U2G
K8iANk2aG1R+CqYiOeeTQ+a4u1Dw4mPPSIsslSvPo8huLRgTZItVz7vx11jIAPFr
LKkuWIf0Xv5UnkIqu4n60lpg3T6nLTh2K+OY1U9PTHS7
-----END CERTIFICATE-----
`;

describe('computeFingerprint', () => {
    it('returns a lowercase, colon-free sha256 hex fingerprint matching X509Certificate.fingerprint256', () => {
        const expected = new X509Certificate(CERT_PEM).fingerprint256.replace(/:/g, '').toLowerCase();
        expect(computeFingerprint(CERT_PEM)).toBe(expected);
        expect(computeFingerprint(CERT_PEM)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('throws on an unparsable PEM', () => {
        expect(() => computeFingerprint('not a certificate')).toThrow();
    });
});

describe('extractCertDomains', () => {
    it('extracts both the subject CN and the SAN DNS entries', () => {
        const x509 = new X509Certificate(CERT_PEM);
        const domains = extractCertDomains(x509);
        expect(domains).toEqual(expect.arrayContaining(['example.com', '*.example.com']));
        expect(domains).toHaveLength(2); // deduped — CN and one SAN entry coincide
    });

    it('ignores a non-DNS SAN entry (e.g. an IP address) and finds no CN', () => {
        const x509 = new X509Certificate(CERT_NO_CN_IP_SAN_PEM);
        expect(extractCertDomains(x509)).toEqual([]);
    });

    it('returns no domains for a certificate with no CN and no SAN extension at all', () => {
        const x509 = new X509Certificate(CERT_NO_CN_NO_SAN_PEM);
        expect(extractCertDomains(x509)).toEqual([]);
    });
});

describe('parseCertificate', () => {
    it('parses notBefore/notAfter as ISO strings, issuer from O=, and the domain list', () => {
        const parsed = parseCertificate(CERT_PEM);
        expect(parsed.issuer).toBe('Nucleus Test CA');
        expect(new Date(parsed.notBefore).toString()).not.toBe('Invalid Date');
        expect(new Date(parsed.notAfter).toString()).not.toBe('Invalid Date');
        expect(new Date(parsed.notAfter).getTime()).toBeGreaterThan(new Date(parsed.notBefore).getTime());
        expect(parsed.domains).toEqual(expect.arrayContaining(['example.com', '*.example.com']));
        expect(parsed.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(parsed.serialNumber).toEqual(expect.any(String));
    });

    it('throws on an unparsable PEM', () => {
        expect(() => parseCertificate('garbage')).toThrow();
    });

    it('handles a certificate with no CN — domains empty, still parses cleanly', () => {
        const parsed = parseCertificate(CERT_NO_CN_NO_SAN_PEM);
        expect(parsed.domains).toEqual([]);
        expect(parsed.issuer).toBe('Nucleus No SAN Cert'); // falls through to O=
    });
});

// NOTE: parseCertificate's `|| x509.issuer` fallback (an issuer DN with no O=
// component) is not exercised — every test cert here is self-signed with an O=
// subject, so issuer always has one too. A real CA without an O= is not something
// this suite can cheaply construct (it'd need a proper CA chain, not a self-signed
// leaf), and node's X509Certificate.serialNumber has no observed way to come back
// empty for an openssl-issued cert, so the `serialNumber ?? null` fallback is
// likewise untested. Both left as documented gaps rather than gamed.

describe('validateKeyPair', () => {
    it('does not throw when the private key matches the certificate', () => {
        expect(() => validateKeyPair(CERT_PEM, MATCHING_KEY_PEM)).not.toThrow();
    });

    it('throws "does not match" when the private key does not correspond to the certificate', () => {
        expect(() => validateKeyPair(CERT_PEM, MISMATCHED_KEY_PEM)).toThrow(
            'Private key does not match the certificate',
        );
    });

    it('throws a specific message for an unparsable certificate body', () => {
        expect(() => validateKeyPair('not a cert', MATCHING_KEY_PEM)).toThrow(
            'Invalid certificate body: could not parse the public key',
        );
    });

    it('throws a specific message for an unparsable private key', () => {
        expect(() => validateKeyPair(CERT_PEM, 'not a key')).toThrow(
            'Invalid private key: could not parse PEM',
        );
    });
});

describe('certificateCoversDomain', () => {
    it('covers its own exact CN', () => {
        expect(certificateCoversDomain(CERT_PEM, 'example.com')).toBe(true);
    });

    it('covers a subdomain via the wildcard SAN', () => {
        expect(certificateCoversDomain(CERT_PEM, 'sub.example.com')).toBe(true);
    });

    it('does not cover an unrelated domain', () => {
        expect(certificateCoversDomain(CERT_PEM, 'other.com')).toBe(false);
    });

    it('does not cover a two-level-deep subdomain (wildcard is single-label)', () => {
        expect(certificateCoversDomain(CERT_PEM, 'a.b.example.com')).toBe(false);
    });
});
