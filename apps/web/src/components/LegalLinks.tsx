const DOCS_ROOT = 'https://josi-ce-docs.netlify.app/';

export const HELP_URL = `${DOCS_ROOT}#help`;
export const TERMS_URL = `${DOCS_ROOT}#terms-of-use`;
export const PRIVACY_URL = `${DOCS_ROOT}#privacy-notice`;
export const COOKIES_URL = `${DOCS_ROOT}#cookie-notice`;
export const LICENCE_URL = `${DOCS_ROOT}#software-and-paid-feature-licences`;

export function LegalLinks({ className = '' }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={className}>
      <a href={TERMS_URL} target="_blank" rel="noreferrer noopener">Terms</a>
      <a href={PRIVACY_URL} target="_blank" rel="noreferrer noopener">Privacy</a>
      <a href={COOKIES_URL} target="_blank" rel="noreferrer noopener">Cookies</a>
      <a href={LICENCE_URL} target="_blank" rel="noreferrer noopener">Licences</a>
    </nav>
  );
}
