import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../..');
const dockerfile = readFileSync(join(root, 'Dockerfile.aio'), 'utf8');
const installer = readFileSync(join(root, 'scripts/aio-install.sh'), 'utf8');
const envExample = readFileSync(join(root, '.env.example'), 'utf8');

describe('the one-shot AIO installer', () => {
  it('is a bootstrapper, not a permanent privileged service', () => {
    expect(dockerfile).toMatch(/^FROM docker:29-cli$/m);
    expect(dockerfile).toMatch(/ENTRYPOINT \["\/usr\/local\/bin\/josi-ce-aio-install"\]/);
    expect(installer).toMatch(/docker compose .* up -d --wait/s);
    expect(installer).toContain('Josi CE is ready');
  });

  it('requires an explicit Docker socket and proves the host path mapping', () => {
    expect(installer).toMatch(/\[\[ -S \/var\/run\/docker\.sock \]\]/);
    expect(installer).toMatch(/docker run --rm -v "\$PWD:\/josi-install:ro"/);
    expect(installer).toContain('-v "$PWD:$PWD" -w "$PWD"');
    expect(installer).toContain('~/.docker/run/docker.sock');
  });

  it('refreshes release-managed files while preserving operator files and existing secrets', () => {
    expect(installer).toContain('policy="${4:-replace}"');
    expect(installer).toContain('Caddyfile 0644 preserve');
    expect(installer).toContain('${target}.pre-${VERSION}');
    expect(installer).toMatch(/bash \.\/install\.sh/);
  });

  it('pins the published stack instead of silently floating on latest', () => {
    expect(dockerfile).toContain('ARG JOSI_VERSION=0.1.0');
    expect(dockerfile).toContain('ENV JOSI_VERSION=$JOSI_VERSION');
    expect(installer).toContain('readonly VERSION="${JOSI_VERSION:-0.1.0}"');
    expect(installer).toContain('JOSI_TAG=${VERSION}');
    expect(installer).toContain('.env.pre-${VERSION}');
    expect(installer).not.toMatch(/JOSI_TAG=latest/);
  });

  it('returns generated files to the invoking host user and makes secrets readable to non-root services', () => {
    expect(installer).toContain("INSTALL_UID=\"$(stat -c '%u' \"$PWD\")\"");
    expect(installer).toContain('chown -R "$INSTALL_UID:$INSTALL_GID" secrets');
    expect(installer).toContain('JOSI_COMPOSE_SECRETS=1 bash ./install.sh');
  });

  it('points the default browser URL at the proxy port that is actually published', () => {
    expect(envExample).toMatch(/^JOSI_APP_URL=http:\/\/localhost$/m);
    expect(envExample).not.toMatch(/^JOSI_APP_URL=http:\/\/localhost:8080$/m);
  });

  it('never accepts or prints secret values', () => {
    expect(installer).not.toMatch(/MASTER_KEY=/);
    expect(installer).not.toMatch(/POSTGRES_PASSWORD=/);
    expect(installer).not.toMatch(/cat .*secrets\//);
  });

  it('is quiet by default, supports verbose output, and persists the requested public URL', () => {
    expect(installer).toContain('[[ "${1:-}" == "--verbose"');
    expect(installer).toContain('--project-name josi-ce pull --quiet');
    expect(installer).toContain('--wait-timeout 300 --quiet-pull');
    expect(installer).toContain('set_env_value JOSI_APP_URL "$JOSI_APP_URL"');
    expect(installer).toContain('set_env_value JOSI_DOMAIN "$JOSI_DOMAIN"');
    expect(installer).toContain('Detailed log: $LOG_FILE');
  });
});
