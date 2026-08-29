import { firstValueFrom } from 'rxjs';
import { Role } from '@/interfaces';
import { ReadOnlyTool } from '@/catalog/tool';
import { textOrNull } from '@/tools/common';

/**
 * Cloud credentials family: which stored cloud credentials this system holds,
 * by name and provider only.
 *
 * `cloudsync_tasks_list` in `tasks.ts` names the credential a task
 * authenticates with by id and name and stops there; this file is the other
 * half of that answer — the list a `credential_id` can be looked up in, so that
 * "the backup is configured" can become "the backup is configured to an account
 * you still recognise".
 *
 * THE ROW THIS READS IS ALMOST ENTIRELY SECRET MATERIAL. A cloud credential's
 * `provider` holds, depending on the provider, an access key and secret access
 * key, an account key, an OAuth token, an SSH password or private key, or a
 * WebDAV password — and the client's own type names nineteen provider shapes,
 * with more arriving in any release. So the mapping below is an ALLOWLIST, as
 * in `certificates.ts` and `pools.ts`, and it is one for a sharper reason than
 * either: a copy with the known secret fields removed would leak the next
 * provider's secret the day TrueNAS adds one. Three fields are named, and
 * nothing that is not named can reach a caller without a change to this file.
 *
 * `cloudsync.credentials.query` IS in the pinned client's call directory for
 * the version this is written against — the ticket's design note recorded it as
 * absent from an endpoint enum and unconfirmed; it is present, and the entity
 * it returns is typed. What is read defensively here is not the field names but
 * the CONTENT of two of them: `provider` has been a bare provider name in
 * releases before the one the pinned types describe, and is an object carrying
 * the configuration in this one.
 */

/**
 * The credential's numeric id, or null where the system reported none this
 * tool could read.
 *
 * Read defensively although the client's type declares a plain `number`,
 * because this is the field `cloudsync_tasks_list` joins on and that tool reads
 * the same id off a task's `credentials` the same way. Two readings of one
 * identity that disagree about what an unreadable id looks like would make a
 * lookup that silently fails look like a credential that is simply missing.
 */
function credentialId(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The provider type as the system names it — `S3`, `AZUREBLOB`, `SFTP` — or
 * null where it named none this tool could read.
 *
 * Read off the row rather than taken from the type, because its SHAPE has
 * changed across releases while its name has not: releases before the one the
 * pinned client describes send `provider` as a bare provider name beside a
 * separate `attributes` object, and the version here sends an object whose
 * `type` is that same name. Both are read, and neither reading carries anything
 * out of the object beyond that one string.
 *
 * NULL IS "THIS SYSTEM NAMED NO PROVIDER TYPE THIS TOOL COULD READ" AND NEVER
 * "A CREDENTIAL WITH NO PROVIDER". Every stored credential has one — it is what
 * decides how the credential is used — so a null here is a credential worth
 * looking at directly rather than one that is somehow provider-less.
 */
function providerType(row: object): string | null {
  const provider = (row as Record<string, unknown>)['provider'];
  const named = textOrNull(provider);
  if (named !== null) return named;
  if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) return null;
  return textOrNull((provider as Record<string, unknown>)['type']);
}

export const cloudCredentialsList: ReadOnlyTool = {
  name: 'cloud_credentials_list',
  description:
    'Every cloud credential stored on this system, by name and provider only. ' +
    '`id` is the credential\'s numeric identity and is what `credential_id` ' +
    'on a task from `cloudsync_tasks_list` refers to, so the two together ' +
    'answer which account a backup is actually going to. It is null where the ' +
    'system reported no id this tool could read, and such a credential cannot ' +
    'be matched to a task from here. `name` is the credential as the system ' +
    'names it, which is what the web UI shows and what `credential_name` on a ' +
    'task repeats; it is null where the system reported none. `provider` is ' +
    'the provider type as the system spells it — `S3`, `AZUREBLOB`, `SFTP`, ' +
    '`GOOGLE_DRIVE` and so on — and is null where the system named no provider ' +
    'type this tool could read. A NULL PROVIDER IS NOT A CREDENTIAL WITHOUT ' +
    'ONE: every stored credential has a provider, so a null there is one worth ' +
    'looking at directly. THIS TOOL RETURNS NO SECRET MATERIAL AND NO ' +
    'CREDENTIAL CONFIGURATION OF ANY KIND. The stored record holds the access ' +
    'key, secret key, account key, OAuth token, password or private key the ' +
    'credential authenticates with, and also its endpoint, region, host and ' +
    'account name; NONE of that appears here, and no field a later ' +
    'TrueNAS release adds to a credential — including a whole new provider ' +
    'with secrets spelled some new way — can appear without a code change, ' +
    'because the three fields above are named explicitly rather than copied ' +
    'with the known secrets removed. It follows that this tool cannot answer ' +
    'which account or host a credential authenticates to: the NAME is the ' +
    'only account of that, and a name is whatever a person typed. This tool ' +
    'also does not say whether a credential still works — nothing here ' +
    'contacts the provider — and does not create, update, delete or verify ' +
    'one. A credential listed here is not evidence that anything uses it; ' +
    '`cloudsync_tasks_list` is what says which tasks reference which ' +
    'credential.',
  inputSchema: { type: 'object', properties: {} },
  requiredRole: Role.ReadOnly,
  mutating: false,
  async handler({ system }) {
    // No filters and no options: a system holds a handful of cloud credentials
    // at most, and all three fields reported are part of a credential row as it
    // stands — there is nothing to bound and no option that changes how it
    // arrives.
    const credentials = await firstValueFrom(
      system.client.api.query('cloudsync.credentials.query'),
    );
    return credentials.map((credential) => ({
      id: credentialId(credential.id),
      name: textOrNull(credential.name),
      provider: providerType(credential),
    }));
  },
};
