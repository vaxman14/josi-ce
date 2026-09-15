// Where backups are stored, and proving it works before anyone relies on it.
//
// S3, Cloudflare R2 and Backblaze B2 are one protocol wearing three sets of
// labels. They all speak the S3 API and are all signed with SigV4; what differs
// is what each vendor's console calls the fields and how the endpoint is
// derived. So the protocol lives in one place and the differences live in a
// catalogue, for the same reason the model providers do: adding a fourth
// S3-compatible vendor should be a table entry, not a branch in a request
// function.
//
// The labels are not cosmetic. "Key ID" and "Application key" are what
// Backblaze shows you; calling them "Access key ID" and "Secret access key"
// because that is what the protocol calls them would leave an operator hunting
// their console for fields that are not there under those names.
import { signRequest, type AwsCredentials } from '@josi-ce/llm';

export type DestinationKind = 's3' | 'r2' | 'b2' | 'nas';

export interface DestinationField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface DestinationDescriptor {
  kind: DestinationKind;
  label: string;
  /** Where the operator gets these values, in that vendor's own words. */
  credentialsHelp: string;
  fields: DestinationField[];
  docsUrl: string;
}

const BUCKET: DestinationField = {
  key: 'bucket',
  label: 'Bucket name',
  secret: false,
  required: true,
  help: 'The bucket must already exist. Josi does not create one.',
};

const PREFIX: DestinationField = {
  key: 'objectPrefix',
  label: 'Folder inside the bucket',
  secret: false,
  required: false,
  placeholder: 'josi/',
  help: 'Optional. Use this if the bucket holds other things too.',
};

export const DESTINATIONS: readonly DestinationDescriptor[] = [
  {
    kind: 'nas',
    label: 'Local NAS / network share',
    credentialsHelp: 'Mount the share into this container under /mnt or /data, then choose that mounted path. Credentials stay with the host mount and never enter Josi.',
    fields: [{ key: 'bucket', label: 'Mounted path', secret: false, required: true, placeholder: '/mnt/josi-backups', help: 'An absolute path under /mnt or /data that already exists inside the Josi container.' }],
    docsUrl: '/help#nas-backups',
  },
  {
    kind: 's3',
    label: 'Amazon S3',
    credentialsHelp:
      'Create an IAM user with access to this bucket only, then take an access key from its '
      + 'Security credentials tab. Josi needs to read, write and list objects in the bucket.',
    fields: [
      BUCKET,
      {
        key: 'region',
        label: 'Region',
        secret: false,
        required: true,
        placeholder: 'us-east-1',
        help: 'The region the bucket was created in, as shown in the S3 console.',
      },
      { key: 'accessKeyId', label: 'Access key ID', secret: true, required: true },
      { key: 'secretAccessKey', label: 'Secret access key', secret: true, required: true },
      {
        key: 'sessionToken',
        label: 'Session token',
        secret: true,
        required: false,
        help: 'Only for temporary credentials. Leave empty for a normal IAM user.',
      },
      {
        key: 'endpoint',
        label: 'Custom endpoint',
        secret: false,
        required: false,
        placeholder: 'https://minio.example.com',
        help:
          'Only for an S3-compatible service that is not Amazon, such as MinIO. Leave empty for '
          + 'Amazon S3 and Josi will work out the address.',
      },
      PREFIX,
    ],
    docsUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/creating-bucket.html',
  },
  {
    kind: 'r2',
    label: 'Cloudflare R2',
    credentialsHelp:
      'In the Cloudflare dashboard open R2, then "Manage R2 API Tokens", and create a token with '
      + 'Object Read & Write on this bucket. Cloudflare shows the access key id and secret once.',
    fields: [
      BUCKET,
      {
        key: 'accountId',
        label: 'Cloudflare account ID',
        secret: false,
        required: true,
        help: 'The long hexadecimal id in your R2 endpoint URL and on the R2 overview page.',
      },
      { key: 'accessKeyId', label: 'Access key ID', secret: true, required: true },
      { key: 'secretAccessKey', label: 'Secret access key', secret: true, required: true },
      PREFIX,
    ],
    docsUrl: 'https://developers.cloudflare.com/r2/api/s3/tokens/',
  },
  {
    kind: 'b2',
    label: 'Backblaze B2',
    credentialsHelp:
      'In Backblaze open "Application Keys" and add a key restricted to this bucket. Backblaze '
      + 'calls the two values keyID and applicationKey, and shows the application key once.',
    fields: [
      BUCKET,
      {
        key: 'region',
        label: 'Region',
        secret: false,
        required: true,
        placeholder: 'us-west-004',
        help: 'The middle part of the S3 endpoint Backblaze shows for the bucket.',
      },
      // Backblaze's own names. The protocol calls these the access key id and
      // the secret access key, and an operator reading their console sees
      // neither of those phrases.
      { key: 'accessKeyId', label: 'keyID', secret: true, required: true },
      { key: 'secretAccessKey', label: 'applicationKey', secret: true, required: true },
      PREFIX,
    ],
    docsUrl: 'https://www.backblaze.com/docs/cloud-storage-s3-compatible-api',
  },
];

export function describeDestination(kind: string): DestinationDescriptor | null {
  return DESTINATIONS.find((d) => d.kind === kind) ?? null;
}

export interface DestinationConfig {
  kind: DestinationKind;
  bucket: string;
  region: string;
  accountId?: string | null;
  /** Only for an S3-compatible service Josi cannot derive. */
  endpoint?: string | null;
  objectPrefix?: string;
}

/** The host to sign for and talk to.
 *
 * Derived wherever it can be. An endpoint an operator typed is one they can
 * mistype, and a mistyped endpoint for a backup destination is somewhere else
 * entirely receiving this installation's data — so only the S3-compatible case,
 * which genuinely cannot be derived, accepts one.
 */
export function endpointHost(config: DestinationConfig): string {
  if (config.kind === 'nas') return 'local-mounted-share';
  if (config.endpoint) {
    const url = new URL(config.endpoint);
    return url.host;
  }
  switch (config.kind) {
    case 'r2':
      return `${config.accountId}.r2.cloudflarestorage.com`;
    case 'b2':
      return `s3.${config.region}.backblazeb2.com`;
    default:
      return `s3.${config.region}.amazonaws.com`;
  }
}

/** R2 has no regions and rejects anything but `auto` in the signature. */
export function signingRegion(config: DestinationConfig): string {
  return config.kind === 'r2' ? 'auto' : config.region;
}

export type DestinationFailure =
  | 'authentication'   // the credential was rejected
  | 'authorization'    // the credential is real but not allowed here
  | 'no_such_bucket'   // the bucket does not exist at this endpoint
  | 'network'          // nothing answered
  | 'unknown';

export interface DestinationCheck {
  ok: boolean;
  category?: DestinationFailure;
  detail: string;
}

/** What each failure means to the person who has to fix it.
 *
 * A status code is not an explanation, and "403" in particular is two very
 * different problems: a wrong secret and a key that is correct but scoped to
 * another bucket. They are separated because the fix is different. */
function explain(status: number, body: string): DestinationCheck {
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? '';
  if (status === 404 || code === 'NoSuchBucket') {
    return {
      ok: false,
      category: 'no_such_bucket',
      detail:
        'That bucket does not exist at this endpoint. Check the name and, for Amazon S3, that the '
        + 'region matches the one the bucket was created in.',
    };
  }
  if (status === 401 || code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch') {
    return {
      ok: false,
      category: 'authentication',
      detail: 'The credential was rejected. Check the key and secret were pasted whole.',
    };
  }
  if (status === 403) {
    return {
      ok: false,
      category: 'authorization',
      detail:
        'The credential is valid but not allowed to use this bucket. Check the key is scoped to '
        + 'this bucket and permits reading, writing and listing.',
    };
  }
  return {
    ok: false,
    category: 'unknown',
    detail: `The storage service answered ${status}${code ? ` (${code})` : ''}.`,
  };
}

export interface CheckOptions {
  config: DestinationConfig;
  credentials: AwsCredentials;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: Date;
}

/** Ask the bucket a real question, with the credential just entered.
 *
 * A list of one object: the cheapest request that proves all three things at
 * once — the endpoint resolves, the signature verifies, and this credential may
 * actually use this bucket. Checking only that the host answers would call a
 * destination working when the first real backup would fail.
 */
export async function testDestination(opts: CheckOptions): Promise<DestinationCheck> {
  const { config, credentials } = opts;
  if (config.kind === 'nas') {
    return { ok: false, category: 'unknown', detail: 'Mounted shares are tested by the server filesystem.' };
  }
  const host = endpointHost(config);
  const region = signingRegion(config);
  // Path-style addressing. Virtual-hosted style would need the bucket in the
  // hostname, which breaks for the S3-compatible endpoints and for any bucket
  // name that is not DNS-safe.
  const path = `/${config.bucket}`;
  const query = { 'list-type': '2', 'max-keys': '1' };

  const signed = signRequest({
    method: 'GET',
    host,
    path,
    query,
    headers: {},
    body: '',
    region,
    service: 's3',
    credentials,
    now: opts.now,
  });

  const doFetch = opts.fetchImpl ?? fetch;
  const url = `https://${host}${path}?list-type=2&max-keys=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: signed.headers,
      signal: controller.signal,
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, detail: 'Josi listed this bucket successfully.' };
    }
    return explain(res.status, await res.text().catch(() => ''));
  } catch {
    return {
      ok: false,
      category: 'network',
      detail:
        'Nothing answered at that address. Check the endpoint, and that this server is allowed to '
        + 'reach it.',
    };
  } finally {
    clearTimeout(timer);
  }
}
