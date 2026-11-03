import { readFile } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import { CredentialProvider, credentialKey, type CredentialRef, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials';
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local';
import AuthorizationService from '@deepseek-ai/dsh-authorization';
import PlatformAccount from '@deepseek-ai/dsh-deepseek-account-platform';

/** Same native parser/account interpretation as Metis; no file-backed provider or write capability. */
export class ReadOnlyDshCredentials extends CredentialProvider {
  private readonly path: string;
  constructor(ctx: Context, path: string) { super(ctx); this.path = path; }
  private async document() {
    try { return parseCredentialsDocument(await readFile(this.path, 'utf8'), this.path); }
    catch { throw new Error('DSH_CREDENTIALS_UNREADABLE'); }
  }
  async resolve(ref: CredentialRef) { const value = (await this.document()).refs.get(ref); return value ? { value, source: 'lyra-read-only' } : undefined; }
  async describe(ref: CredentialRef) { return { configured: !!(await this.document()).refs.get(ref), source: 'lyra-read-only', writable: false }; }
  async readRecord(key: CredentialKey) { return (await this.document()).records.get(key); }
  async describeRecord(key: CredentialKey) { const r = await this.readRecord(key); return { configured: !!r, ...(r ? { kind: r.kind } : {}), writable: false }; }
  async listRecords() { return [...(await this.document()).records].map(([key, r]) => ({ key: key as CredentialKey, kind: r.kind })); }
  async set(_ref: CredentialRef, _value: string): Promise<void> { throw new Error('DSH_CREDENTIAL_MUTATION_DENIED'); }
  async unset(_ref: CredentialRef): Promise<void> { throw new Error('DSH_CREDENTIAL_MUTATION_DENIED'); }
  async modifyRecord(_key: CredentialKey, _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> { throw new Error('DSH_CREDENTIAL_MUTATION_DENIED'); }
  async deleteRecord(_key: CredentialKey): Promise<void> { throw new Error('DSH_CREDENTIAL_MUTATION_DENIED'); }
}

export async function openReadOnlyDshAccount(input: { credentialsPath: string; platformOrigin: string; endpoint: string; validation: boolean }) {
  const ctx = new Context();
  try {
    await ctx.plugin(ReadOnlyDshCredentials, input.credentialsPath);
    await ctx.plugin(AuthorizationService);
    await ctx.plugin(PlatformAccount, { platformOrigin: input.platformOrigin, inferenceOrigin: new URL(input.endpoint).origin, allowLoopbackHttp: input.validation, desktopPlatform: null });
    const record = await ctx.credentials.describeRecord(credentialKey('deepseek-account-platform', 'default'));
    if (!record.configured || record.kind !== 'grant') throw new Error('DSH_ACCOUNT_UNBOUND');
    return {
      async resolveAuth() {
        // The pinned resolveToken reads the stored grant only. No profile, refresh, sign-in or error hook.
        const token = await ctx.deepseekAccount.resolveToken(input.endpoint);
        if (!token) throw new Error('DSH_ACCOUNT_UNBOUND');
        if (input.validation !== token.startsWith('lyra_test_')) throw new Error('DSH_CREDENTIAL_ENDPOINT_MISMATCH');
        return { headers: { 'x-dsh-auth-token': token } };
      },
      async close() { await ctx.fiber.dispose(); },
    };
  } catch {
    await ctx.fiber.dispose();
    throw new Error('DSH_ACCOUNT_UNAVAILABLE');
  }
}
