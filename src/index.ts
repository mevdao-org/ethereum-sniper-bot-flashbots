import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
  webSocket,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { broadcastBundleMultiBuilder, simulateFlashbotsBundle } from "./flashbots.js";
import { simulateTokenSafetyOnAnvil } from "./simulator.js";

/**
 * MEV DAO Reference Implementation: Block-0 Flashbots Sniper Bot
 * Website: https://mevdao.org
 * Deep-Dive Architecture Guide:
 * https://mevdao.org/blog/ethereum-sniper-bot-flashbots-same-block-sniping-on-uniswap
 */

const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as const;

const ADD_LIQUIDITY_ABI = parseAbi([
  "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)",
]);

const EXECUTOR_ABI = parseAbi([
  "function snipeWithCoinbaseBribe(address token, uint256 swapAmountWei, uint256 bribeAmountWei, uint256 maxTaxBps, address recipient) external payable",
]);

async function main() {
  const httpRpc = process.env.ETH_HTTP_RPC_URL || "https://eth.llamarpc.com";
  const wsRpc = process.env.ETH_WS_RPC_URL;
  const anvilRpc = process.env.ANVIL_FORK_RPC_URL || "http://127.0.0.1:8545";

  const sniperPk = (process.env.SNIPER_PRIVATE_KEY ||
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex;
  const flashbotsAuthPk = (process.env.FLASHBOTS_AUTH_KEY ||
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as Hex;

  const targetToken = (process.env.TARGET_TOKEN_ADDRESS || "").toLowerCase();
  const buyAmountWei = parseEther(process.env.BUY_AMOUNT_ETH || "0.25");
  const bribeAmountWei = parseEther(process.env.BUILDER_BRIBE_ETH || "0.05");
  const maxBuyTaxBps = Number(process.env.MAX_BUY_TAX_BPS || "1000");
  const maxSellTaxBps = Number(process.env.MAX_SELL_TAX_BPS || "1000");
  const executorAddress = (process.env.EXECUTOR_CONTRACT_ADDRESS ||
    "0x0000000000000000000000000000000000001337") as Address;

  const sniperAccount = privateKeyToAccount(sniperPk);
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(httpRpc),
  });
  const walletClient = createWalletClient({
    account: sniperAccount,
    chain: mainnet,
    transport: http(httpRpc),
  });

  console.log("===============================================================");
  console.log("  MEV DAO Block-0 Flashbots Sniper Bot (https://mevdao.org)");
  console.log("===============================================================");
  console.log(`Sniper Signer     : ${sniperAccount.address}`);
  console.log(`Target Token      : ${targetToken || "ANY (Watching all Uniswap V2 launches)"}`);
  console.log(`Buy Size / Bribe  : ${process.env.BUY_AMOUNT_ETH || "0.25"} ETH / ${process.env.BUILDER_BRIBE_ETH || "0.05"} ETH`);
  console.log(`Max Buy/Sell Tax  : ${maxBuyTaxBps / 100}% / ${maxSellTaxBps / 100}%`);

  if (!wsRpc) {
    console.log(
      "\n[INFO] ETH_WS_RPC_URL not configured. Running dry-run bundle construction check..."
    );
    const blockNumber = await publicClient.getBlockNumber();
    console.log(`[OK] Connected to Ethereum Mainnet at block #${blockNumber}`);
    console.log(
      "[READY] Set ETH_WS_RPC_URL in .env to stream pending addLiquidityETH transactions in real time."
    );
    return;
  }

  const wsClient = createPublicClient({
    chain: mainnet,
    transport: webSocket(wsRpc),
  });

  wsClient.watchPendingTransactions({
    onTransactions: async (hashes) => {
      for (const txHash of hashes) {
        try {
          const tx = await publicClient.getTransaction({ hash: txHash });
          if (!tx || !tx.to || tx.to.toLowerCase() !== UNISWAP_V2_ROUTER.toLowerCase()) {
            continue;
          }

          // Check selector for addLiquidityETH (0xf305d719)
          if (!tx.input.startsWith("0xf305d719")) continue;

          const decoded = decodeFunctionData({
            abi: ADD_LIQUIDITY_ABI,
            data: tx.input,
          });
          const launchedToken = (decoded.args[0] as Address).toLowerCase();

          if (targetToken && launchedToken !== targetToken) continue;

          console.log(`\n[DETECTED] Pending addLiquidityETH for token ${launchedToken} (tx: ${txHash})`);

          // 1. Obtain raw signed transaction bytes of the developer's pending liquidity tx
          const rawDevTx = (await publicClient.request({
            method: "eth_getRawTransactionByHash" as any,
            params: [txHash],
          })) as Hex;

          // 2. Simulate honeypot & tax check on Anvil fork before risking any gas or bribe
          const safety = await simulateTokenSafetyOnAnvil(
            anvilRpc,
            rawDevTx,
            launchedToken as Address,
            sniperAccount.address,
            buyAmountWei
          );

          if (
            safety.isHoneypot ||
            safety.buyTaxBps > maxBuyTaxBps ||
            safety.sellTaxBps > maxSellTaxBps
          ) {
            console.warn(
              `[ABORT] Token failed safety check! Honeypot=${safety.isHoneypot}, BuyTax=${safety.buyTaxBps}bps, SellTax=${safety.sellTaxBps}bps, Reason=${safety.reason || "Tax threshold exceeded"}`
            );
            continue;
          }

          console.log(
            `[SAFE] Passed Anvil fork simulation! BuyTax=${safety.buyTaxBps / 100}%, SellTax=${safety.sellTaxBps / 100}%`
          );

          // 3. Construct our signed backrun transaction calling FlashbotsSniperExecutor
          const currentBlock = await publicClient.getBlock();
          const targetBlockNumber = (currentBlock.number ?? 0n) + 1n;
          const nonce = await publicClient.getTransactionCount({ address: sniperAccount.address });

          const callData = encodeFunctionData({
            abi: EXECUTOR_ABI,
            functionName: "snipeWithCoinbaseBribe",
            args: [
              launchedToken as Address,
              buyAmountWei,
              bribeAmountWei,
              BigInt(maxBuyTaxBps),
              sniperAccount.address,
            ],
          });

          const signedSniperTx = await walletClient.signTransaction({
            account: sniperAccount,
            to: executorAddress,
            data: callData,
            value: buyAmountWei + bribeAmountWei,
            nonce,
            gas: 280_000n,
            maxFeePerGas: (currentBlock.baseFeePerGas ?? 15_000_000_000n) * 2n,
            maxPriorityFeePerGas: 2_000_000_000n,
          });

          // 4. Pre-flight check with eth_callBundle
          const simResult = await simulateFlashbotsBundle(
            {
              txs: [rawDevTx, signedSniperTx],
              blockNumber: targetBlockNumber,
            },
            currentBlock.number ?? 0n,
            flashbotsAuthPk
          );

          console.log(
            `[SIMULATED] eth_callBundle succeeded! Effective Bundle Gas Price: ${simResult.bundleGasPrice} wei, Coinbase Diff: ${simResult.coinbaseDiff} wei`
          );

          // 5. Fan out bundle across Flashbots, Beaverbuild, Titan, and Rsync
          const broadcastResults = await broadcastBundleMultiBuilder(
            {
              txs: [rawDevTx, signedSniperTx],
              blockNumber: targetBlockNumber,
            },
            flashbotsAuthPk
          );

          console.table(broadcastResults);
        } catch {
          // Ignore non-matching or already mined transactions
        }
      }
    },
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
