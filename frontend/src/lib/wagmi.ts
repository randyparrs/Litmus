// Wallet setup: RainbowKit + wagmi on a single network, GenLayer Studio Next.
//
// genlayerChain (in node.ts) is the single source of truth for the chain: the genlayer-js client
// and the wallet both read it, which is what keeps them from talking to two different nodes
// (studioDevnet's bundled rpcUrls point at studio-dev, a DIFFERENT node).

import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { injectedWallet } from '@rainbow-me/rainbowkit/wallets';
import { genlayerChain } from './node';

// Browser-extension wallets only, as in Synarch: signing on a custom network (61997) means the
// wallet has to add the chain first, which is a desktop extension flow. EIP-6963 discovers every
// installed wallet on its own (MetaMask, Rabby, Coinbase...); this entry is the window.ethereum
// fallback. WalletConnect is deliberately not registered: without a real project id its entry is
// a dead end (the relay answers 403).
const WALLETCONNECT_PROJECT_ID = 'litmus-unused';

export const wagmiConfig = getDefaultConfig({
  appName: 'Litmus',
  projectId: WALLETCONNECT_PROJECT_ID,
  wallets: [{ groupName: 'Installed', wallets: [injectedWallet] }],
  chains: [genlayerChain as any],
});
