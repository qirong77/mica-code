import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export type ConfigWebAdvertisedUrlOptions = {
  publicUrl?: string;
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
};

export function resolveConfigWebBindHost(configuredHost = process.env.MICA_CONFIG_WEB_HOST): string {
  return configuredHost?.trim() || '127.0.0.1';
}

export function resolveConfigWebAdvertisedUrl(port: number, options: ConfigWebAdvertisedUrlOptions = {}): string {
  const configuredUrl = options.publicUrl ?? process.env.MICA_CONFIG_WEB_PUBLIC_URL;
  if (configuredUrl?.trim()) return normalizePublicUrl(configuredUrl, port);

  const bindHost = resolveConfigWebBindHost();
  if (isLoopbackHost(bindHost)) {
    return `http://${bindHost}:${port}`;
  }
  const address = firstExternalIpv4(options.interfaces ?? networkInterfaces());
  const advertisedHost = address ?? bindHost;
  return `http://${advertisedHost}:${port}`;
}

function normalizePublicUrl(value: string, port: number): string {
  const expanded = value.trim().replaceAll('{port}', String(port));
  let parsed: URL;
  try {
    parsed = new URL(expanded);
  } catch {
    throw new Error('MICA_CONFIG_WEB_PUBLIC_URL must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('MICA_CONFIG_WEB_PUBLIC_URL must use http or https');
  }
  if (isLoopbackHost(parsed.hostname)) {
    throw new Error('MICA_CONFIG_WEB_PUBLIC_URL must not use a loopback host');
  }
  return expanded.replace(/\/+$/, '');
}

function firstExternalIpv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string | undefined {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && !entry.address.startsWith('127.')) {
        return entry.address;
      }
    }
  }
  return undefined;
}

function isLoopbackHost(value: string): boolean {
  const host = value.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}
