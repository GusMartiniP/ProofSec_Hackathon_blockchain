'use client';

import React, { FC, ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { RPC_URL } from '@/lib/config';
import { ProofSecProvider } from '@/hooks/useProofSec';
import '@solana/wallet-adapter-react-ui/styles.css';

/**
 * Phantom, Solflare, Backpack etc. implementam o Wallet Standard e são
 * detectadas automaticamente — não é preciso instanciar adapters.
 */
export const WalletContextProvider: FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <ProofSecProvider>{children}</ProofSecProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};
