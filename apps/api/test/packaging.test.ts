// The compose file and Dockerfile encode security properties, so they are
// asserted here rather than trusted to review. A future edit that publishes the
// database port, puts the master key in an environment variable, or starts
// ClamAV by default fails the suite instead of shipping.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '../../..');
const compose = parse(readFileSync(join(root, 'docker-compose.yml'), 'utf8')) as any;
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
const caddyfile = readFileSync(join(root, 'Caddyfile'), 'utf8');
const installer = readFileSync(join(root, 'scripts/install.sh'), 'utf8');

const service = (name: string) => compose.services[name];

describe('the stack has the four required services', () => {
  it('defines web, worker, db and caddy', () => {
    for (const name of ['web', 'worker', 'db', 'caddy']) {
      expect(compose.services, name).toHaveProperty(name);
    }
  });

  it('runs migrations as a separate step the app waits for', () => {
    expect(service('migrate')).toBeDefined();
    // Starting against an unmigrated database should be impossible, not just
    // unlikely.
    expect(service('web').depends_on.migrate.condition).toBe('service_completed_successfully');
    expect(service('worker').depends_on.migrate.condition).toBe('service_completed_successfully');
  });
});

describe('optional components are inert unless asked for', () => {
  it('puts OCR and ClamAV behind profiles', () => {
    expect(service('ocr').profiles).toEqual(['ocr']);
    expect(service('clamav').profiles).toEqual(['clamav']);
  });

  it('does not put a required service behind a profile', () => {
    // Compose treats the active profile set as a whole: naming any profile
    // deactivates the empty one. Caddy previously carried profiles ["",
    // "default"], so `docker compose --profile ocr up -d` — the documented way
    // to enable OCR — silently dropped the reverse proxy and took HTTPS
    // offline. A required service must have no `profiles` key at all.
    for (const name of ['web', 'worker', 'db', 'caddy', 'migrate']) {
      expect(service(name).profiles, `${name} must not be profile-gated`).toBeUndefined();
    }
  });

  it('offers bring-your-own-proxy as an override rather than a profile', () => {
    const override = parse(readFileSync(join(root, 'docker-compose.noproxy.yml'), 'utf8')) as any;
    // The override publishes web directly, since Caddy is scaled to zero.
    expect(override.services.web.ports).toBeDefined();
  });

  it('does not list them as dependencies of anything that starts by default', () => {
    for (const name of ['web', 'worker', 'db', 'caddy', 'migrate']) {
      const deps = Object.keys(service(name).depends_on ?? {});
      expect(deps, name).not.toContain('ocr');
      expect(deps, name).not.toContain('clamav');
    }
  });

  it('caps the resources of the component most likely to hurt a small machine', () => {
    // OCR is the one that eats a Raspberry Pi alive.
    expect(service('ocr').deploy.resources.limits).toHaveProperty('memory');
    expect(service('ocr').deploy.resources.limits).toHaveProperty('cpus');
    expect(service('clamav').deploy.resources.limits).toHaveProperty('memory');
  });
});

describe('secrets are files, never environment variables', () => {
  it('declares both secrets as files', () => {
    expect(compose.secrets.josi_master_key.file).toBe('./secrets/master.key');
    expect(compose.secrets.josi_db_password.file).toBe('./secrets/db_password');
  });

  it('gives web and worker the master key as a mounted secret', () => {
    for (const name of ['web', 'worker']) {
      expect(service(name).secrets, name).toContain('josi_master_key');
      expect(service(name).environment.MASTER_KEY_FILE, name).toMatch(/^\/run\/secrets\//);
    }
  });

  it('never places key material in any service environment', () => {
    for (const [name, svc] of Object.entries<any>(compose.services)) {
      const env = svc.environment ?? {};
      for (const forbidden of ['MASTER_KEY', 'CREDENTIALS_KEY', 'POSTGRES_PASSWORD', 'PGPASSWORD']) {
        expect(Object.keys(env), `${name}.${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('has postgres read its password from a file too', () => {
    expect(service('db').environment.POSTGRES_PASSWORD_FILE).toMatch(/^\/run\/secrets\//);
  });

  it('never bakes a secret into the image', () => {
    expect(dockerfile).not.toMatch(/master\.key/);
    expect(dockerfile).not.toMatch(/COPY\s+secrets/);
    // No ENV at all whose name looks like a credential. The path default lives
    // in code instead, so BuildKit's SecretsUsedInArgOrEnv check stays useful
    // rather than being suppressed file-wide.
    const envNames = [...dockerfile.matchAll(/^ENV\s+([A-Z0-9_]+)=/gm)].map((m) => m[1]);
    for (const name of envNames) {
      expect(name, `ENV ${name}`).not.toMatch(/KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL/i);
    }
  });

  it('keeps the master-key path default in code, not in the image', () => {
    const masterKeySrc = readFileSync(join(root, 'packages/core/src/masterKey.ts'), 'utf8');
    expect(masterKeySrc).toMatch(/DEFAULT_MASTER_KEY_PATH = '\/run\/secrets\/josi_master_key'/);
  });

  it('generates the key from a CSPRNG and never prints it', () => {
    expect(installer).toMatch(/openssl rand -base64 32|head -c 32 \/dev\/urandom/);
    expect(installer).toMatch(/umask 077/);
    expect(installer).toMatch(/chmod 600/);
    // Refuses to clobber an existing key: a new one orphans every stored
    // credential rather than rotating it.
    expect(installer).toMatch(/already exists .*leaving it alone/s);
    // No `cat`/`echo` of the key file anywhere.
    expect(installer).not.toMatch(/cat\s+"?\$?\{?MASTER_KEY/);
  });
});

describe('least-privilege networking', () => {
  it('never publishes the database', () => {
    expect(service('db').ports).toBeUndefined();
  });

  it('keeps the database on the data network only', () => {
    expect(service('db').networks).toEqual(['data']);
  });

  it('keeps the proxy on the edge network only, so it cannot reach the database', () => {
    expect(service('caddy').networks).toEqual(['edge']);
  });

  it('keeps the worker off the edge network', () => {
    expect(service('worker').networks).toEqual(['data']);
    expect(service('worker').ports).toBeUndefined();
  });

  it('publishes only the proxy', () => {
    const published = Object.entries<any>(compose.services)
      .filter(([, svc]) => Array.isArray(svc.ports) && svc.ports.length)
      .map(([name]) => name);
    expect(published).toEqual(['caddy']);
  });
});

describe('container hardening', () => {
  it('drops capabilities and forbids privilege escalation on the app services', () => {
    for (const name of ['web', 'worker', 'migrate']) {
      expect(service(name).cap_drop, name).toContain('ALL');
      expect(service(name).security_opt, name).toContain('no-new-privileges:true');
    }
  });

  it('runs the app with a read-only root filesystem', () => {
    for (const name of ['web', 'worker']) {
      expect(service(name).read_only, name).toBe(true);
      // A read-only rootfs still needs somewhere to write, and it must be a
      // tmpfs rather than a volume that survives.
      expect(service(name).tmpfs, name).toBeDefined();
    }
  });

  it('runs the image as a non-root user', () => {
    expect(dockerfile).toMatch(/^USER node$/m);
  });

  it('gives Caddy exactly the one capability it needs and no more', () => {
    // Binding 80/443 as a non-root process is the single reason it keeps any
    // capability at all.
    expect(service('caddy').cap_drop).toContain('ALL');
    expect(service('caddy').cap_add).toEqual(['NET_BIND_SERVICE']);
  });

  it('sets restart policies on everything long-running', () => {
    for (const name of ['web', 'worker', 'db', 'caddy']) {
      expect(service(name).restart, name).toBe('unless-stopped');
    }
    // The migrator is a one-shot; restarting it forever would be wrong.
    expect(service('migrate').restart).toBe('no');
  });

  it('health-checks every long-running service', () => {
    for (const name of ['web', 'worker', 'db', 'caddy']) {
      expect(service(name).healthcheck, name).toBeDefined();
      expect(service(name).healthcheck.test, name).toBeTruthy();
    }
  });

  it('uses named volumes so data survives a container being replaced', () => {
    expect(compose.volumes).toHaveProperty('db_data');
    expect(service('db').volumes).toContain('db_data:/var/lib/postgresql/data');
  });
});

describe('the proxy', () => {
  it('is templated on a domain rather than hard-coded to anything', () => {
    expect(caddyfile).toMatch(/\{\$JOSI_DOMAIN\}/);
    // No hosted-product hostname may appear here.
    expect(caddyfile).not.toMatch(/heyjosi|socalreceptionist/i);
  });

  it('sets the security headers a private workspace tool should send', () => {
    for (const header of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'X-Robots-Tag']) {
      expect(caddyfile, header).toContain(header);
    }
  });

  it('binds its admin API to loopback', () => {
    expect(caddyfile).toMatch(/admin 127\.0\.0\.1:2019/);
  });

  it('never passes a bare, defaultless env substitution as a directive argument', () => {
    // Caddy substitutes an unset variable with nothing, so `email {$FOO}` with
    // FOO unset becomes a bare `email` — a parse error that restart-loops the
    // container on every install that did not set it. Cost a real boot to find.
    // Either give the substitution a default, or do not emit the line.
    const offenders = caddyfile
      .split('\n')
      .map((line, i) => [i + 1, line.trim()] as const)
      .filter(([, line]) => !line.startsWith('#'))
      // A directive whose only argument is {$VAR} with no `:default`.
      .filter(([, line]) => /^[a-z_]+\s+\{\$[A-Z0-9_]+\}\s*$/.test(line));
    expect(offenders, `defaultless substitution(s): ${JSON.stringify(offenders)}`).toEqual([]);
  });
});

describe('no capacity claims are made anywhere', () => {
  it('publishes no user or concurrency numbers before benchmarks exist', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    // Phrases that would be a claim rather than a description.
    for (const pattern of [/supports up to \d+/i, /\d+\s*(concurrent )?users/i, /handles \d+/i]) {
      expect(readme, String(pattern)).not.toMatch(pattern);
    }
  });
});

describe('the image can actually be built', () => {
  /** Found the hard way in Phase 4: `packages/llm` was added to the workspace
   * but not to the Dockerfile's dependency layer. `tsc -b` passed locally
   * against an already-linked node_modules and the image build failed on a
   * clean host with "cannot find module @josi-ce/llm".
   *
   * npm creates a workspace's node_modules symlink only if its package.json
   * exists at `npm ci` time, so every workspace must be COPYed before it. */
  it('copies every workspace package.json before npm ci', () => {
    const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces: string[] };
    const workspaces = rootPkg.workspaces.flatMap((pattern) => {
      const dir = pattern.replace(/\/\*$/, '');
      return readdirSync(join(root, dir), { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(root, dir, e.name, 'package.json')))
        .map((e) => `${dir}/${e.name}`);
    });

    expect(workspaces.length).toBeGreaterThan(2);
    const beforeInstall = dockerfile.split('RUN npm ci')[0];
    for (const ws of workspaces) {
      // The API and worker share one image; whichever workspaces exist, each
      // one's manifest has to be present before the install.
      expect(beforeInstall, `${ws}/package.json is not COPYed before npm ci`)
        .toContain(`${ws}/package.json`);
    }
  });
});
