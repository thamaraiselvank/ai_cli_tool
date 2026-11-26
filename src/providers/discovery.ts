import type { Settings } from '../config/settings.js';
import { resolveKey, type KeySource } from '../config/credentials.js';
import { getProvider, isChatModel, isLocalProvider, listModels, PROVIDERS } from './index.js';

export interface ProviderStatus {
  name: string;
  local: boolean;
  /** Cloud: where the key comes from (undefined = no key). */
  keySource?: KeySource;
  /** Local: whether the server answered. */
  running?: boolean;
  signup?: string;
  apiKeyEnv?: string;
}

/** Every known provider (built-in + settings) with its setup state. Local servers get a quick ping. */
export async function providerStatuses(settings: Settings): Promise<ProviderStatus[]> {
  const names = [...new Set([...Object.keys(PROVIDERS), ...Object.keys(settings.providers ?? {})])];
  return Promise.all(
    names.map(async (name): Promise<ProviderStatus> => {
      const info = getProvider(name, settings.providers);
      if (isLocalProvider(info)) {
        // Short timeout: a stopped local server should not make the picker feel slow.
        const running = await listModels(name, false, settings.providers, undefined, 800).then(
          () => true,
          () => false,
        );
        return { name, local: true, running };
      }
      return {
        name,
        local: false,
        keySource: resolveKey(name, info.apiKeyEnv)?.source,
        signup: info.signup,
        apiKeyEnv: info.apiKeyEnv,
      };
    }),
  );
}

export const isUsable = (p: ProviderStatus) => (p.local ? p.running : Boolean(p.keySource));

/** All chat models from every usable provider, as "provider/model". Failing providers are skipped. */
export async function discoverModels(settings: Settings): Promise<{ models: string[]; errors: string[] }> {
  const usable = (await providerStatuses(settings)).filter(isUsable);
  const results = await Promise.allSettled(
    usable.map(async (p) =>
      // OpenRouter lists hundreds of models, mostly paid. Jarvis targets free use, so its picker shows
      // only the free ones; a paid model can still be set directly: /model openrouter/<id>.
      (await listModels(p.name, p.name === 'openrouter', settings.providers)).filter(isChatModel).map((id) => `${p.name}/${id}`),
    ),
  );
  const models: string[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') models.push(...r.value);
    else errors.push(`${usable[i]!.name}: ${(r.reason as Error).message.slice(0, 120)}`);
  });
  return { models, errors };
}
