/**
 * Server-only S3 access for certificate material (PEM bytes). The DB stores only
 * S3 object keys; this module reads/writes the actual bytes. Material is laid out
 * per version: certificates/{tenantId}/{certId}/v{n}/{body|chain|private}.
 *
 * NOTE: backfilled v1 versions keep the legacy flat keys
 * (certificates/{tenantId}/{certId}/body.pem); always read by the stored key,
 * never by reconstructing the path.
 */
import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
} from '@aws-sdk/client-s3';

export const APP_BUCKET = process.env.APP_BUCKET_NAME || '';

function s3(): S3Client {
    return new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
}

export interface CertMaterial {
    body: string;
    chain?: string;
    privateKey: string;
}

export interface VersionKeys {
    s3BodyKey: string;
    s3ChainKey: string | null;
    s3PrivateKeyKey: string;
}

export function versionS3Prefix(tenantId: string, certId: string, version: number): string {
    return `certificates/${tenantId}/${certId}/v${version}`;
}

/** Upload a version's material; returns the stored S3 keys. */
export async function putVersionMaterial(
    prefix: string,
    material: CertMaterial
): Promise<VersionKeys> {
    const client = s3();
    const bodyKey = `${prefix}/body.pem`;
    const keyKey = `${prefix}/private.key`;
    const chainKey = material.chain ? `${prefix}/chain.pem` : null;

    await Promise.all([
        client.send(
            new PutObjectCommand({
                Bucket: APP_BUCKET,
                Key: bodyKey,
                Body: material.body,
                ContentType: 'application/x-pem-file',
            })
        ),
        client.send(
            new PutObjectCommand({
                Bucket: APP_BUCKET,
                Key: keyKey,
                Body: material.privateKey,
                ContentType: 'application/x-pem-file',
            })
        ),
        chainKey
            ? client.send(
                  new PutObjectCommand({
                      Bucket: APP_BUCKET,
                      Key: chainKey,
                      Body: material.chain,
                      ContentType: 'application/x-pem-file',
                  })
              )
            : Promise.resolve(),
    ]);

    return { s3BodyKey: bodyKey, s3ChainKey: chainKey, s3PrivateKeyKey: keyKey };
}

/** Load a version's material from S3 by its stored keys. */
export async function loadVersionMaterial(keys: VersionKeys): Promise<CertMaterial> {
    const client = s3();
    const [bodyObj, chainObj, keyObj] = await Promise.all([
        client.send(new GetObjectCommand({ Bucket: APP_BUCKET, Key: keys.s3BodyKey })),
        keys.s3ChainKey
            ? client.send(new GetObjectCommand({ Bucket: APP_BUCKET, Key: keys.s3ChainKey }))
            : Promise.resolve(null),
        client.send(new GetObjectCommand({ Bucket: APP_BUCKET, Key: keys.s3PrivateKeyKey })),
    ]);
    return {
        body: await bodyObj.Body!.transformToString(),
        chain: chainObj ? await chainObj.Body!.transformToString() : undefined,
        privateKey: await keyObj.Body!.transformToString(),
    };
}

/** Delete a set of S3 objects (ignores nulls). Best-effort per key. */
export async function deleteMaterial(keys: (string | null | undefined)[]): Promise<void> {
    const client = s3();
    await Promise.all(
        keys
            .filter((k): k is string => Boolean(k))
            .map(key =>
                client
                    .send(new DeleteObjectCommand({ Bucket: APP_BUCKET, Key: key }))
                    .catch(() => undefined)
            )
    );
}
