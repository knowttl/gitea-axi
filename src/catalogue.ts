import { readFileSync } from 'node:fs';
import { CliError } from './error.js';
import type { Command } from './registry.js';

interface BaselineCommand {
  id: string;
  path: string;
  arguments: string;
  classification: string;
  expectedOutcome: string;
  flags: { name: string; baselineDisposition: string }[];
}
export const baseline = (JSON.parse(readFileSync(new URL('../schemas/catalogue.json', import.meta.url), 'utf8')) as {
  baseline: string; target: string; commands: BaselineCommand[];
}).commands;

export function commandGap(path: string): string | undefined {
  if (/^(discussion|gist|project) /.test(path)) return 'No corresponding discussion, gist or Projects v2 API is documented in the retained Gitea 1.23.4 or 1.24.0 specifications';
  if (/^issue (lock|unlock)$/.test(path)) return 'Gitea 1.23.4 has no documented issue lock contract; the retained 1.24.0 lock candidate is not commissioned';
  if (/^issue (transfer|subissue )/.test(path)) return 'Gitea 1.23.4 and 1.24.0 provide no evidenced issue transfer or parent/child subissue contract; repository transfer and dependencies are different operations';
  if (path === 'pr ready') return 'Gitea 1.23.4 and 1.24.0 do not document a draft transition field in EditPullRequestOption';
  if (path === 'setup hooks') return 'C096: retained gh-axi 0.1.46 help does not specify supported agent paths, configuration schemas or repair semantics; hook installation remains pending';
  if (path === 'update' || path === 'update --check') return 'C122/C123: retained gh-axi 0.1.46 help does not establish the distribution, integrity or rollback contract; update and check-only remain pending';
  if (path === 'api HEAD') return 'Gitea 1.23.4 has no documented HEAD operation/effect contract; no GET substitution is performed';
  if (path === 'pr review') return 'Gitea 1.23.4 and 1.24.0 do not establish review event values or atomic stale-head rejection (CX-007); review posting remains pending';
  if (path === 'dashboard') return 'C121: exact gh-axi 0.1.46 sections and defaults are not captured; the owned bounded repository dashboard is not baseline parity';
  if (path.startsWith('workflow ') || path.startsWith('run ') && path !== 'run list') return 'Gitea 1.23.4 has task summaries only; retained 1.24.0 workflow/run candidates remain uncommissioned';
  if (path === 'search code') return 'Gitea 1.23.4 has no evidenced code search API/query contract';
  if (path === 'stack submit') return 'The required automatic merge scheduling contract remains pending';
  return;
}

export function flagGap(path: string, name: string): string {
  if (name === 'jq' || name === 'template') return '--' + name + ' compatibility is not implemented: no jq evaluator or template engine/grammar has been selected; Gitea 1.23.4 responses do not supply these local semantics';
  return '--' + name + ' has no implemented compatibility contract for ' + path + ' on Gitea 1.23.4; see capabilities for the retained baseline outcome';
}

export function capabilityOutput(commands: Command[], fields: string[], id?: string) {
  if (id && !baseline.some(row => row.id === id)) throw new CliError('USAGE', 'Select a catalogue ID C001 through C124', 2);
  const rows = baseline.filter(row => !id || row.id === id).map(row => {
    const path = row.path === 'update --check' ? 'update' : row.path.startsWith('api ') ? 'api' : row.path;
    const command = commands.find(command => command.path.join(' ') === path);
    const gap = commandGap(row.path) ?? command?.gap;
    const flags = row.flags.map(flag => {
      const name = flag.name === '-X' ? 'method' : flag.name.replace(/^--/, '');
      const meta = command?.flags[name];
      return { ...flag, status: !meta || meta.gap || gap ? 'gap' : 'available with owned semantics',
        contract: gap ?? meta?.gap ?? 'Use command help; baseline semantic parity is not claimed by flag acceptance' };
    });
    return id ? { ...row, status: gap ? 'gap' : 'partial', gap: gap ?? null, flags } :
      { id: row.id, command: 'gitea-axi ' + row.path, status: gap ? 'gap' : 'partial', flags: flags.length };
  });
  return { baseline: 'gh-axi 0.1.46', target: 'Gitea 1.23.4',
    counts: { commands: baseline.length, commandFlags: baseline.reduce((count, row) => count + row.flags.length, 0), globals: 4, prFields: fields.length, fullParity: 0 },
    commands: rows,
    ...(id ? {} : { globals: [
      { selector: '-R/--repo', contract: 'Explicit repository before matching local remote; stack rejects it and GH_REPO' },
      { selector: '--hostname/GH_HOST', contract: 'Select exactly one matching configured profile by host and port; exact tokenOrigin binding applies before secret resolution' },
      { selector: '--help', contract: 'Offline registry-derived help' },
      { selector: '-v/-V/--version', contract: 'Offline packaged version' },
    ], prFields: fields.map(field => ({ field, contract: field === 'id' ? 'gap: GraphQL node ID unavailable; fullDatabaseId is the numeric vendor ID' :
      field === 'statusCheckRollup' ? 'partial commit statuses only; excludes full check suites' :
        ['autoMergeRequest', 'closingIssuesReferences', 'mergeStateStatus', 'potentialMergeCommit', 'projectCards', 'projectItems', 'reviewDecision'].includes(field) ? 'gap: no evidenced Gitea 1.23.4 field contract' : 'owned normalized field; see pr view --fields' })) }),
    help: id ? ['gitea-axi capabilities'] : ['gitea-axi capabilities C038'],
  };
}
