// Chain integration seam. Fleuri has no deployed contracts or mint yet, so the only
// active adapter is the sandbox (virtual SOL). A real adapter must be configured with
// genuine Fleuri program IDs before any real-money path is enabled.
export interface ChainConfig {
  network: "sandbox" | "devnet" | "mainnet-beta";
  programId: string | null;
  mint: string | null;
}

export interface ChainAdapter {
  readonly config: ChainConfig;
  readonly realMoney: boolean;
  describe(): string;
}

export const sandboxChain: ChainAdapter = {
  config: { network: "sandbox", programId: null, mint: null },
  realMoney: false,
  describe: () => "Sandbox · virtual SOL. No on-chain transactions are created.",
};

export function getChain(): ChainAdapter {
  const programId = import.meta.env.VITE_FLEURI_PROGRAM_ID as string | undefined;
  if (programId) {
    // Placeholder: configuration detected but no audited adapter ships yet.
    return { ...sandboxChain, describe: () => "Program ID configured, but real trading adapter is not enabled. Running sandbox." };
  }
  return sandboxChain;
}
