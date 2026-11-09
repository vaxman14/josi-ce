// Companion apps.
//
// Where to get them, and how one reaches this server. Pairing itself lives on
// Devices, so this page only points there.
import { Link } from 'react-router-dom';
import { Card, CardTitle } from '@/components/ui';

export function Apps() {
  return (
    <div className="page">
      <h1 className="page-title">Companion apps</h1>

      <Card>
        <CardTitle>Get the app</CardTitle>
        <ul className="space-y-1 text-sm text-muted-foreground">
          <li>
            iPhone and iPad:{' '}
            <a className="underline" href="https://apps.apple.com/us/app/josi-ce/id6810549193" target="_blank" rel="noreferrer noopener">Josi CE on the App Store</a>
          </li>
          <li>
            Android:{' '}
            <a className="underline" href="https://play.google.com/store/apps/details?id=com.socalreceptionist.josice" target="_blank" rel="noreferrer noopener">Josi CE on Google Play</a>
          </li>
        </ul>
      </Card>

      <Card>
        <CardTitle>Connect it to this server</CardTitle>
        <p className="text-sm text-muted-foreground">
          Open <Link className="underline" to="/app/devices">Devices</Link> and make a pairing code. Scan it or
          paste it into the app, then sign in with your normal Josi account. The connection is encrypted from
          your phone to this server, and each device has its own key.
        </p>
      </Card>
    </div>
  );
}
