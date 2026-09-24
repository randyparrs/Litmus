// The wallet corner of the desktop header. RainbowKit does the connecting (ConnectButton.Custom,
// so the markup stays the Win98 one from the design); wagmi gives the address, chain and balance.

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useDisconnect } from 'wagmi';
import type { Wallet } from '../lib/useWallet';

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

export function WalletHeader({ wallet }: { wallet: Wallet }) {
  const { disconnect } = useDisconnect();

  return (
    <ConnectButton.Custom>
      {({ openConnectModal, mounted }) => {
        if (!mounted || !wallet.connected) {
          return (
            <button className="wallet-connect-button bevel-raised" type="button" onClick={openConnectModal}>
              Connect Wallet
            </button>
          );
        }
        if (wallet.wrongChain) {
          return (
            <button className="wallet-connect-button bevel-raised" type="button" onClick={wallet.switchChain}>
              Switch to GenLayer Studio Next
            </button>
          );
        }
        return (
          <div className="wallet-panel bevel-groove">
            <img className="wallet-dot" src="/assets/icon-connected-dot.svg" width="10" height="10" alt="" />
            <span className="wallet-network">Studio Next</span>
            <span className="wallet-field bevel-groove">{short(wallet.address!)}</span>
            <span className="wallet-field bevel-groove">{wallet.balanceGen ?? '...'} GEN</span>
            <button className="wallet-disconnect-button bevel-raised" type="button" onClick={() => disconnect()}>
              Disconnect
            </button>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
