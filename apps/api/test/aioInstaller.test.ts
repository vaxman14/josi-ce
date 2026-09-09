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
    expect(installer).toMatch(/installer container has exited/);
  });

  it('requires an explicit Docker socket and proves the host path mapping', () => {
    expect(installer).toMatch(/\[\[ -S \/var\/run\/docker\.sock \]\]/);
    expect(installer).toMatch(/docker run --rm -v "\$PWD:\/josi-install:ro"/);
    expect(installer).toContain('-v "$PWD:$PWD" -w "$PWD"');
    expect(installer).toContain('~/.docker/run/docker.sock');
  });

  it('does not overwrite operator files or regenerate existing secrets', () => {
    expect(installer).toMatch(/if \[\[ -e "\$target" \]\]/);
    expect(installer).toMatch(/leaving existing \$target unchanged/);
    expect(installer).toMatch(/bash \.\/install\.sh/);
  });

  it('pins the published stack instead of silently floating on latest', () => {
    expect(dockerfile).toContain('ARG JOSI_VERSION=0.1.0');
    expect(dockerfile).toContain('ENV JOSI_VERSION=$JOSI_VERSION');
    expect(installer).toContain('readonly VERSION="${JOSI_VERSION:-0.1.0}"');
    expect(installer).toContain('JOSI_TAG=${VERSION}');
    expect(installer).not.toMatch(/JOSI_TAG=latest/);
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
});
