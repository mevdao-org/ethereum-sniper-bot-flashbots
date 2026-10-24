import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Multi-Builder Endpoints for Maximum Block-0 Inclusion
 * See: https://mevdao.org/blog/flashbots-bundles-explained-how-to-send-eth-sendbundle-and-why-yours-isn-t-landi
 */
export const BUILDER_RELAYS = [
  { name: "Flashbots", url: "https://relay.flashbots.net" },
  { name: "Beaverbuild", url: "https://rpc.beaverbuild.org" },
  { name: "Titan Builder", url: "https://rpc.titanbuilder.xyz" },
  { name: "Rsync Builder", url: "https://rsync-builder.xyz" },
] as const;

export interface FlashbotsBundleParams {
  txs: Hex[];
  blockNumber: bigint;
  minTimestamp?: number;
  maxTimestamp?: number;
  revertingTxHashes?: Hex[];
}

export interface CallBundleResult {
  bundleGasPrice: string;
  bundleHash: string;
  coinbaseDiff: string;
  ethSentToCoinbase: string;
  gasFees: string;
  results: Array<{
    txHash: string;
    gasUsed: number;
    value?: string;
    error?: string;
    revert?: string;
  }>;
  stateBlockNumber: number;
  totalGasUsed: number;
}

/**
 * Signs a Flashbots JSON-RPC payload according to EIP-191:
 * Header format: `<signerAddress>:<signature(keccak256(body))>`
 */
export async function signFlashbotsPayload(bodyString: string, authPrivateKey: Hex): Promise<string> {
  const authAccount = privateKeyToAccount(authPrivateKey);
  const bodyHash = keccak256(toBytes(bodyString));
  const signature = await authAccount.signMessage({
    message: bodyHash,
  });
  return `${authAccount.address}:${signature}`;
}

/**
 * Simulates a bundle against Flashbots relay via `eth_callBundle` before broadcasting.
 */
export async function simulateFlashbotsBundle(
  params: FlashbotsBundleParams,
  stateBlockNumber: bigint,
  authPrivateKey: Hex,
  relayUrl = "https://relay.flashbots.net"
): Promise<CallBundleResult> {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_callBundle",
    params: [
      {
        txs: params.txs,
        blockNumber: `0x${params.blockNumber.toString(16)}`,
        stateBlockNumber: `0x${stateBlockNumber.toString(16)}`,
      },
    ],
  };

  const body = JSON.stringify(payload);
  const signatureHeader = await signFlashbotsPayload(body, authPrivateKey);

  const response = await fetch(relayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Flashbots-Signature": signatureHeader,
    },
    body,
  });

  const json = (await response.json()) as { result?: CallBundleResult; error?: { message: string } };
  if (json.error) {
    throw new Error(`eth_callBundle RPC error: ${json.error.message}`);
  }
  if (!json.result) {
    throw new Error("Empty eth_callBundle response");
  }
  return json.result;
}

/**
 * Fans out an atomic `eth_sendBundle` payload simultaneously across top Ethereum block builders
 * (Flashbots, Beaverbuild, Titan, Rsync) to achieve >90% block-0 coverage.
 */
export async function broadcastBundleMultiBuilder(
  params: FlashbotsBundleParams,
  authPrivateKey: Hex
): Promise<Array<{ builder: string; bundleHash?: string; error?: string }>> {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendBundle",
    params: [
      {
        txs: params.txs,
        blockNumber: `0x${params.blockNumber.toString(16)}`,
        ...(params.minTimestamp ? { minTimestamp: params.minTimestamp } : {}),
        ...(params.maxTimestamp ? { maxTimestamp: params.maxTimestamp } : {}),
        ...(params.revertingTxHashes ? { revertingTxHashes: params.revertingTxHashes } : {}),
      },
    ],
  };

  const body = JSON.stringify(payload);
  const signatureHeader = await signFlashbotsPayload(body, authPrivateKey);

  const tasks = BUILDER_RELAYS.map(async (relay) => {
    try {
      const res = await fetch(relay.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Flashbots-Signature": signatureHeader,
        },
        body,
      });
      const data = (await res.json()) as { result?: { bundleHash: string }; error?: { message: string } };
      if (data.error) {
        return { builder: relay.name, error: data.error.message };
      }
      return { builder: relay.name, bundleHash: data.result?.bundleHash };
    } catch (err) {
      return { builder: relay.name, error: (err as Error).message };
    }
  });

  return Promise.all(tasks);
}
