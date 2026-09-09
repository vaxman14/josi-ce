// Channels: the ways you reach Josi that are not this web app.
//
// One sidebar entry, not one per transport. Telegram had a top-level item of
// its own, which made the first channel look like a category — and would have
// made the second one either a second top-level item or an inconsistency. The
// package boundary in packages/channels already says these are instances of one
// thing; the navigation says so too now.
//
// Each channel is the individual user's own. This page lists what exists and
// sends you into that channel's own setup; it never configures anything itself,
// and there is no installation-wide account here to configure.
import { Link } from 'react-router-dom';
import { Card, CardTitle } from '@/components/ui';

interface ChannelEntry {
  id: string;
  label: string;
  to: string;
  summary: string;
}

/** The channels this build actually has. A transport is added here when it can
 * be set up, not when work on it starts — a row that leads to nothing is the
 * same broken promise as a disabled button. */
const CHANNELS: ChannelEntry[] = [
  {
    id: 'telegram',
    label: 'Telegram',
    to: '/app/channels/telegram',
    summary:
      'Message Josi from Telegram. You link your own Telegram account, and only messages from '
      + 'the chat you linked are treated as yours.',
  },
];

export function Channels() {
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Channels</h1>
      <p className="text-sm text-muted-foreground">
        Ways to reach Josi other than this app. Each one is yours: you set it up, you can undo it,
        and an administrator cannot read what you send through it.
      </p>

      {CHANNELS.map((channel) => (
        <Card key={channel.id}>
          <Link to={channel.to} className="block min-h-11">
            <CardTitle>{channel.label}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{channel.summary}</p>
            <span className="mt-2 inline-block text-sm underline">Set up {channel.label}</span>
          </Link>
        </Card>
      ))}
    </div>
  );
}
