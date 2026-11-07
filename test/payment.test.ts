import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erc20TransferData, eip681TransferUri, EvmPayment, paymentFor, USDC_ARBITRUM } from '../src/payment.js';

const DEPOSIT = '0x' + 'Bb'.repeat(20);

test('encodes ERC-20 transfer calldata: selector + two 32-byte words', () => {
  const data = erc20TransferData(DEPOSIT, '1020000'); // 1020000 = 0xf9060
  assert.equal(data, '0xa9059cbb' + '0'.repeat(24) + 'bb'.repeat(20) + '0'.repeat(59) + 'f9060');
  assert.equal(data.length, 2 + 8 + 64 + 64);
});

test('calldata rejects bad addresses and non-integer amounts', () => {
  assert.throws(() => erc20TransferData('0x1234', '1'), /address/);
  for (const bad of ['1.02', '0', '-5', '', '1e6']) assert.throws(() => erc20TransferData(DEPOSIT, bad), /integer/);
});

test('builds the EIP-681 transfer URI for Arbitrum One', () => {
  assert.equal(
    eip681TransferUri(USDC_ARBITRUM, 42161, DEPOSIT, '1020000'),
    `ethereum:0xaf88d065e77c8cC2239327C5EDb3A432268e5831@42161/transfer?address=${DEPOSIT}&uint256=1020000`,
  );
});

test('paymentFor targets the USDC contract on 0xa4b1, and skips orders it cannot pay', () => {
  const p = paymentFor({ originChain: 'arb', depositAddress: DEPOSIT, amountBase: '1020000' }) as EvmPayment;
  assert.equal(p.chainIdHex, '0xa4b1');
  assert.equal(p.tx.to, USDC_ARBITRUM);
  assert.equal(p.tx.value, '0x0');
  assert.equal(p.tx.data, erc20TransferData(DEPOSIT, '1020000'));
  // 'base' was the example of an unpayable chain before multi-chain; it is payable now, so use an unknown chain.
  assert.equal(paymentFor({ originChain: 'doge', depositAddress: DEPOSIT, amountBase: '1' }), undefined);
  assert.equal(paymentFor({ originChain: 'arb', depositAddress: DEPOSIT, amountBase: '' }), undefined);
});
