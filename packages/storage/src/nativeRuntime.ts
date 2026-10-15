/** The native Mac package uses the bundled document parsers without a scanner. */
export const nativeMac = () => process.platform === 'darwin' && process.env.JOSI_NATIVE_RUNTIME === '1';
