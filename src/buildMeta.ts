declare const __MICA_BUILD_TIME__: string | undefined;
declare const __MICA_VERSION__: string | undefined;

export const BUILD_TIME = typeof __MICA_BUILD_TIME__ === 'string' ? __MICA_BUILD_TIME__ : 'dev';
export const VERSION = typeof __MICA_VERSION__ === 'string' ? __MICA_VERSION__ : '0.1.0-dev';
