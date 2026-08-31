import {
  APP_NAME,
  CONFIG_DIR_NAME,
  RUNTIME_NAME,
  VERSION_LABEL,
} from '@packages/mica-config/brand.js';

// Brand placeholders usable inside text templates (e.g. system.md). Keys map
// to the build-time branding constants injected from mica.build.env. Unknown
// placeholders are left untouched so templates fail loudly rather than
// silently dropping content.
const BRAND_TEMPLATE_VALUES: Record<string, string> = {
  MICA_APP_NAME: APP_NAME,
  MICA_RUNTIME_NAME: RUNTIME_NAME,
  MICA_VERSION_LABEL: VERSION_LABEL,
  MICA_CONFIG_DIR_NAME: CONFIG_DIR_NAME,
};

export function applyBrandTemplate(text: string): string {
  return text.replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (match, key: string) => {
    const value = BRAND_TEMPLATE_VALUES[key];
    return value === undefined ? match : value;
  });
}
