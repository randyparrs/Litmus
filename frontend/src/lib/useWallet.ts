// The wallet, as the rest of the app sees it: a signer for runVerification, the balance shown in
// the header, and whether it is usable at all (connected, right chain, has GEN for the fees).

import { useEffect, useState } from 'react';
import { useAccount, useBalance, useSwitchChain } from 'wagmi';
import type { Signer } from './node';
import { genlayerChain } from './node';

export interface Wallet {
  address?: `0x${string}`;
  connected: boolean;
  wrongChain: boolean;
  balanceGen?: string;   // formatted, e.g. "12.4081"
  hasGas: boolean;       // balance > 0: the network charges the fees
  signer: Signer | null; // null until it can actually sign
  switchChain: () => void;
}

export function useWallet(): Wallet {
  const { address, isConnected, chainId, connector } = useAccount();
  const { switchChain } = useSwitchChain();
  const wrongChain = isConnected && chainId !== genlayerChain.id;
  const { data: balance } = useBalance({ address, chainId: genlayerChain.id, query: { enabled: !!address } });

  // genlayer-js signs through the wallet's EIP-1193 provider, which the connector owns. A
  // reconnected session can hand back a connector without getProvider (seen in the browser), so
  // the call is guarded and falls back to the injected provider instead of crashing the app.
  const [provider, setProvider] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    const injected = (window as any).ethereum ?? null;
    if (!isConnected) { setProvider(null); return; }
    const get = (connector as any)?.getProvider;
    if (typeof get !== 'function') { setProvider(injected); return; }
    Promise.resolve(get.call(connector))
      .then((p) => { if (alive) setProvider(p ?? injected); })
      .catch(() => { if (alive) setProvider(injected); });
    return () => { alive = false; };
  }, [connector, isConnected]);

  const balanceGen = balance ? Number(balance.formatted).toFixed(4) : undefined;
  const hasGas = !!balance && balance.value > 0n;

  return {
    address,
    connected: isConnected,
    wrongChain,
    balanceGen,
    hasGas,
    signer: address && provider && !wrongChain ? { address, provider } : null,
    switchChain: () => switchChain({ chainId: genlayerChain.id }),
  };
}
