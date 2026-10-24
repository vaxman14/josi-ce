// Connectors: one page for everything people may connect (item 41 on the web).
//
// "Account providers" is the installation's own OAuth applications (Google,
// Microsoft, Dropbox, Box) and who may use each capability. "Developer
// services" is who may connect GitHub, Netlify, Vercel, Supabase and Custom
// APIs with their own tokens. Both answered the same administrator question
// on two pages; they are two views of this one.
import { useSearchParams } from 'react-router-dom';
import { Page, Segmented } from '@/components/ui';
import { AdminConnectors } from './Connectors';
import { AdminDeveloperServices } from './DeveloperServices';

type View = 'accounts' | 'developer';

export function AdminConnectorsHub() {
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'developer' ? 'developer' : 'accounts';
  return (
    <Page title="Connectors" subtitle="What people may connect to Josi: their accounts with the big providers, and their developer services.">
      <Segmented
        label="Kind of connector"
        value={view}
        options={[{ value: 'accounts', label: 'Account providers' }, { value: 'developer', label: 'Developer services' }]}
        onChange={next => setParams(next === 'accounts' ? {} : { view: next }, { replace: true })}
      />
      {view === 'accounts' ? <AdminConnectors embedded /> : <AdminDeveloperServices embedded />}
    </Page>
  );
}
