/** The native Mac and Linux packages use the bundled document parsers without a scanner. */
export const nativeMac = () => process.platform === 'darwin' && process.env.JOSI_NATIVE_RUNTIME === '1';
export const nativeLinux = () => process.platform === 'linux' && process.env.JOSI_NATIVE_RUNTIME === '1';
export const nativePosix = () => nativeMac() || nativeLinux();
