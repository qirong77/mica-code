declare const __MICA_BUILD_TIME__: string | undefined;

export const BUILD_TIME = typeof __MICA_BUILD_TIME__ === 'string' ? __MICA_BUILD_TIME__ : 'dev';
