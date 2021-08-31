export const BnsErrors = {
  NoSuchNamespace: {
    error: 'No such namespace',
  },
  InvalidPageNumber: {
    error: 'Invalid page',
  },
  NoSuchName: {
    error: 'No such name',
  },
  InvalidNameOrSubdomain: {
    error: 'Invalid name or subdomain',
  },
};

export const printTopic = 'print';
export const enum BnsContractIdentifier {
  mainnet = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.bns',
  testnet = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.bns',
}
export const namespaceReadyFunction = 'namespace-ready';
export const nameFunctions = [
  'name-import',
  'name-revoke',
  'name-update',
  'name-transfer',
  'name-renewal',
  'name-register',
];

export const bnsBlockchain = 'stacks';
