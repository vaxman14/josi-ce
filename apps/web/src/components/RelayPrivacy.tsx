// The short version, shown wherever someone decides whether to use the relay.
// docs/RELAY_PRIVACY.md is the long one, and says the same things.
import { Card, CardTitle } from '@/components/ui';

export function RelayPrivacy() {
  return (
    <Card>
      <CardTitle>What the relay can and can't see</CardTitle>
      <div className="space-y-2 text-sm">
        <p><strong>It can't read or change your traffic.</strong> Your devices and this server encrypt everything end to end, and the relay holds no key.</p>
        <p><strong>It can see:</strong> your address, whether this server is online, when devices connect, their internet addresses, and roughly how much data moves.</p>
        <p><strong>Browsers:</strong> a small starter page comes from the relay, so a browser has to trust it. The apps don't have this limit.</p>
        <p><strong>Hey Josi AI:</strong> if you use it, your requests pass through Hey Josi on their way to OpenAI. It counts the cost and keeps no text. Your own AI key avoids this.</p>
        <p><strong>Google:</strong> your tokens are stored only on this server. Hey Josi handles them in memory when you connect and each time one is refreshed, and keeps none.</p>
        <p>Your Hey Josi account can't open this server. You can also run your own relay, or use none.</p>
      </div>
    </Card>
  );
}
