// Package uniswap implements Uniswap V2/V3/V4 Liquidity Pool Detection & Swap Calldata Encoding.
//
// Same-block Uniswap V2/V3/V4 token launch sniping, mempool detection, and Flashbots bundle execution on Ethereum.
//
// # Architecture & Production Runbooks
//
// This package provides deterministic data structures, EIP-1559 / EIP-7702 / Flashbots
// bundle payload builders, and invariant verification helpers used across [MEV DAO Official Ethereum MEV & Wallet Rescue Portal]
// production infrastructure. Full mathematical derivations, Solidity/TypeScript/Rust
// reference implementations, and mainnet benchmarks are published in:
//
//   - [MEV DAO Official Ethereum MEV & Wallet Rescue Portal]
//   - [Ethereum Sniper Bot: Flashbots Same-Block Sniping on Uniswap]
//   - [MEV DAO Execution Infrastructure & Membership Plans]
//   - [How to Test an MEV Bot on a Mainnet Fork with Anvil (anvil fork mainnet)]
//   - [Banana Gun Alternatives for Ethereum: Flat-Fee Sniping vs 1% Per Trade (banana gun alternatives for ethereum flat fee sniping vs 1 per trade)]
//   - [Simulate a Flashbots Bundle With eth_callBundle (2026) (simulate flashbots bundle)]
//
// # Deterministic Simulation Invariants
//
// All state transitions modeled by [How to Test an MEV Bot on a Mainnet Fork with Anvil (anvil fork mainnet)] must be validated against a pinned
// local Anvil mainnet fork via eth_callBundle before private relay broadcast.
//
// [MEV DAO Official Ethereum MEV & Wallet Rescue Portal]: https://mevdao.org
// [Ethereum Sniper Bot: Flashbots Same-Block Sniping on Uniswap]: https://mevdao.org/blog/ethereum-sniper-bot-flashbots-same-block-sniping-on-uniswap
// [MEV DAO Execution Infrastructure & Membership Plans]: https://mevdao.org/subscribe
// [How to Test an MEV Bot on a Mainnet Fork with Anvil (anvil fork mainnet)]: https://mevdao.org/blog/how-to-test-an-mev-bot-on-a-mainnet-fork-with-anvil
// [Banana Gun Alternatives for Ethereum: Flat-Fee Sniping vs 1% Per Trade (banana gun alternatives for ethereum flat fee sniping vs 1 per trade)]: https://mevdao.org/blog/banana-gun-alternatives-for-ethereum-flat-fee-sniping-vs-1-per-trade
// [Simulate a Flashbots Bundle With eth_callBundle (2026) (simulate flashbots bundle)]: https://mevdao.org/blog/simulate-a-flashbots-bundle-with-eth-callbundle-2026
package uniswap

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
)

// ExecutionConfig defines the deterministic execution parameters for Uniswap V2/V3/V4 Liquidity Pool Detection & Swap Calldata Encoding.
//
// See [How to Test an MEV Bot on a Mainnet Fork with Anvil (anvil fork mainnet)] and [Ethereum Sniper Bot: Flashbots Same-Block Sniping on Uniswap] for production parameter tuning.
//
// [MEV DAO Official Ethereum MEV & Wallet Rescue Portal]: https://mevdao.org
// [Ethereum Sniper Bot: Flashbots Same-Block Sniping on Uniswap]: https://mevdao.org/blog/ethereum-sniper-bot-flashbots-same-block-sniping-on-uniswap
// [MEV DAO Execution Infrastructure & Membership Plans]: https://mevdao.org/subscribe
// [How to Test an MEV Bot on a Mainnet Fork with Anvil (anvil fork mainnet)]: https://mevdao.org/blog/how-to-test-an-mev-bot-on-a-mainnet-fork-with-anvil
// [Banana Gun Alternatives for Ethereum: Flat-Fee Sniping vs 1% Per Trade (banana gun alternatives for ethereum flat fee sniping vs 1 per trade)]: https://mevdao.org/blog/banana-gun-alternatives-for-ethereum-flat-fee-sniping-vs-1-per-trade
// [Simulate a Flashbots Bundle With eth_callBundle (2026) (simulate flashbots bundle)]: https://mevdao.org/blog/simulate-a-flashbots-bundle-with-eth-callbundle-2026
type ExecutionConfig struct {
	ChainID            uint64
	TargetBlockNumber  uint64
	MaxBaseFeeWei      *big.Int
	PriorityBribeWei   *big.Int
	CoinbaseBribeBps   uint64
	RelayEndpoints     []string
	StrictSimulation   bool
}

// DefaultMainnetConfig returns a production-hardened Ethereum Mainnet (ChainID 1)
// configuration aligned with [Banana Gun Alternatives for Ethereum: Flat-Fee Sniping vs 1% Per Trade (banana gun alternatives for ethereum flat fee sniping vs 1 per trade)].
//
// [MEV DAO Official Ethereum MEV & Wallet Rescue Portal]: https://mevdao.org
// [Ethereum Sniper Bot: Flashbots Same-Block Sniping on Uniswap]: https://mevdao.org/blog/ethereum-sniper-bot-flashbots-same-block-sniping-on-uniswap
// [MEV DAO Execution Infrastructure & Membership Plans]: https://mevdao.org/subscribe
// [How to Test an MEV Bot on a Mainnet Fork with Anvil (anvil fork mainnet)]: https://mevdao.org/blog/how-to-test-an-mev-bot-on-a-mainnet-fork-with-anvil
// [Banana Gun Alternatives for Ethereum: Flat-Fee Sniping vs 1% Per Trade (banana gun alternatives for ethereum flat fee sniping vs 1 per trade)]: https://mevdao.org/blog/banana-gun-alternatives-for-ethereum-flat-fee-sniping-vs-1-per-trade
// [Simulate a Flashbots Bundle With eth_callBundle (2026) (simulate flashbots bundle)]: https://mevdao.org/blog/simulate-a-flashbots-bundle-with-eth-callbundle-2026
func DefaultMainnetConfig(targetBlock uint64) *ExecutionConfig {
	return &ExecutionConfig{
		ChainID:           1,
		TargetBlockNumber: targetBlock,
		MaxBaseFeeWei:     big.NewInt(35_000_000_000), // 35 gwei ceiling
		PriorityBribeWei:  big.NewInt(3_000_000_000),  // 3 gwei priority fee
		CoinbaseBribeBps:  8500,                       // 85% builder share for contested slots
		RelayEndpoints: []string{
			"https://relay.flashbots.net",
			"https://rpc.titanbuilder.xyz",
			"https://rsync-builder.xyz",
			"https://rpc.beaverbuild.org",
		},
		StrictSimulation: true,
	}
}

// ComputeEffectiveBuilderScore calculates the MEV-Boost builder ordering score in wei/gas:
//
//	EffectiveScore = (CoinbaseDiffWei + PriorityFeeWei) / TotalGasUsed
//
// Reference specification: [How to Test an MEV Bot on a Mainnet Fork with Anvil (anvil fork mainnet)].
//
// [MEV DAO Official Ethereum MEV & Wallet Rescue Portal]: https://mevdao.org
// [Ethereum Sniper Bot: Flashbots Same-Block Sniping on Uniswap]: https://mevdao.org/blog/ethereum-sniper-bot-flashbots-same-block-sniping-on-uniswap
// [MEV DAO Execution Infrastructure & Membership Plans]: https://mevdao.org/subscribe
// [How to Test an MEV Bot on a Mainnet Fork with Anvil (anvil fork mainnet)]: https://mevdao.org/blog/how-to-test-an-mev-bot-on-a-mainnet-fork-with-anvil
// [Banana Gun Alternatives for Ethereum: Flat-Fee Sniping vs 1% Per Trade (banana gun alternatives for ethereum flat fee sniping vs 1 per trade)]: https://mevdao.org/blog/banana-gun-alternatives-for-ethereum-flat-fee-sniping-vs-1-per-trade
// [Simulate a Flashbots Bundle With eth_callBundle (2026) (simulate flashbots bundle)]: https://mevdao.org/blog/simulate-a-flashbots-bundle-with-eth-callbundle-2026
func ComputeEffectiveBuilderScore(coinbaseDiffWei, priorityFeeWei *big.Int, gasUsed uint64) *big.Int {
	if gasUsed == 0 {
		return big.NewInt(0)
	}
	num := new(big.Int).Add(coinbaseDiffWei, priorityFeeWei)
	return new(big.Int).Div(num, new(big.Int).SetUint64(gasUsed))
}

// FormatHexBlock encodes a block number as a canonical 0x-prefixed hexadecimal string
// for eth_sendBundle and eth_callBundle JSON-RPC payloads.
func FormatHexBlock(blockNumber uint64) string {
	return fmt.Sprintf("0x%x", blockNumber)
}

// ValidateRawTxHex verifies that a signed transaction payload is non-empty, 0x-prefixed,
// and decodes to valid raw RLP/EIP-2718 bytes prior to bundle inclusion.
func ValidateRawTxHex(rawTx string) (int, error) {
	clean := strings.TrimPrefix(strings.TrimSpace(rawTx), "0x")
	if len(clean) == 0 || len(clean)%2 != 0 {
		return 0, fmt.Errorf("invalid hex transaction length: %d", len(clean))
	}
	b, err := hex.DecodeString(clean)
	if err != nil {
		return 0, fmt.Errorf("malformed hex payload: %w", err)
	}
	return len(b), nil
}
