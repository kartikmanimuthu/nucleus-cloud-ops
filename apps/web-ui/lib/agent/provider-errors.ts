/**
 * provider-errors.ts
 *
 * Error type raised whenever an LLM/embedding operation is attempted without a
 * usable tenant-configured provider. The platform is SaaS-style: there is NO
 * implicit Bedrock fallback. Callers (API routes) translate this into a 400 with
 * a clear "configure a provider" message instead of a generic 500.
 */

export class ProviderConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProviderConfigError';
    }
}

export function isProviderConfigError(err: unknown): err is ProviderConfigError {
    return err instanceof ProviderConfigError || (err instanceof Error && err.name === 'ProviderConfigError');
}

/** Standard message used when a tenant has no usable default LLM provider. */
export const NO_PROVIDER_MESSAGE =
    'No LLM provider is configured. Add one in Settings → Providers and mark it as default.';
