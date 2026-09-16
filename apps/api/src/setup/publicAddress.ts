import type { Db } from '@josi-ce/core';

export interface PublicAddress {
  origin: string;
  hostname: string;
  tlsMode: 'bundled_caddy' | 'external_proxy';
}

/** Parse the installer-owned browser origin.  This deliberately accepts LAN
 * HTTP as well as public HTTPS: changing back to LAN must repair stale public
 * metadata just as reliably as changing between two public domains. */
export function publicAddressFromEnvironment(appUrl: string, accessMode = process.env.JOSI_ACCESS_MODE): PublicAddress {
  const url = new URL(appUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || (url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('APP_URL is not a valid installation origin');
  }
  if ((accessMode === 'domain' || accessMode === 'proxy') && url.protocol !== 'https:') {
    throw new Error('the configured public installation origin must use HTTPS');
  }
  return {
    origin: url.origin,
    hostname: url.hostname.toLowerCase(),
    tlsMode: accessMode === 'proxy' ? 'external_proxy' : 'bundled_caddy',
  };
}

/** Keep every persisted derivative of APP_URL in one PostgreSQL statement.
 *
 * PostgreSQL statement atomicity is important here.  The network controller
 * considers the new stack ready only after API startup succeeds.  Therefore a
 * database error prevents readiness and makes the controller restore the old
 * .env/Compose/Caddy shape; the restored API then runs this same statement
 * with the old APP_URL, completing the rollback without a split-brain window.
 *
 * Telegram's remote registration is intentionally not contacted at boot.  Its
 * stored URL is updated so the UI cannot report the obsolete address as
 * current; the operator can then re-register after DNS/TLS is reachable.
 */
export async function reconcilePublicAddress(db: Db, address: PublicAddress): Promise<void> {
  await db.query(
    `with deployment as (
       update deployment_config
          set domain = $1, tls_mode = $2,
              certificate_verified_at = case when domain is distinct from $1 then null else certificate_verified_at end
        where id = true
        returning domain
     ), workspace_changed as (
       update workspace
          set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{publicAddress}', to_jsonb($3::text), true)
        where id = true
        returning id
     ), oauth_changed as (
       update oauth_clients
          set redirect_uri = $3 || '/api/connections/' || provider || '/callback'
        where redirect_uri is distinct from $3 || '/api/connections/' || provider || '/callback'
        returning provider
     )
     update telegram_config
        set webhook_url = $3 || '/telegram/webhook', webhook_set_at = null
      where id = true and webhook_url is not null
        and webhook_url is distinct from $3 || '/telegram/webhook'`,
    [address.hostname, address.tlsMode, address.origin],
  );
}
